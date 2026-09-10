// Inbound HTTP receiver for pushed OCSF events. OpenShell does not itself POST
// audit events (see the openshell-ocsf-egress note); this source exists for
// deployments where an external log-shipper (Filebeat, Vector, Fluent Bit) tails
// the OCSF file and forwards it to us. Because OpenShell is not the sender, the
// transport contract is ours to define:
//
//   - Auth is a shared bearer token we require (constant-time compared), so an
//     unauthenticated POST to the ingest port cannot inject into the feed.
//   - The default body is NDJSON of bare OCSF objects (one JSON object per line),
//     which is what a shipper sends when pointed at the JSONL file. A JSON array
//     is also accepted. CloudEvents (single or batch) is parsed only when the
//     content-type asks for it, since it is opt-in wrapping, not the native form.
//   - Every parsed object is handed to the shared ingestor; malformed items are
//     counted and reported in the response, never silently dropped.
//
// This module is deliberately post-only I/O: it never imports the decision path
// and performs no gRPC. Its only outward effect is calling the injected ingestor.

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { childLogger } from "../logger";
import { parseCloudEventsBody } from "./cloudevents";
import type { Ingestor, IngestOutcome } from "./pipeline";

const log = childLogger("capture-http");

const MAX_BODY_BYTES = 5 * 1024 * 1024; // reject oversized bodies (413)
const RETRY_AFTER_SECONDS = 5; // backpressure hint for a shipper when the queue is full

export interface ReceiverDeps {
  // "host:port" to bind. IPv6 hosts may be bracketed, e.g. "[::1]:8090".
  bind: string;
  // Shared secret required in `Authorization: Bearer <token>`.
  token: string;
  // Called for each successfully parsed OCSF object; returns the disposition.
  ingest: Ingestor;
  // TLS: both required together to serve HTTPS; otherwise plain HTTP (expected to
  // sit behind a TLS-terminating proxy or on a trusted network).
  tlsCertPath?: string;
  tlsKeyPath?: string;
  maxBodyBytes?: number;
}

interface IngestTally {
  posted: number;
  filtered: number;
  dropped: number;
  bad: number;
}

export class Receiver {
  private readonly deps: ReceiverDeps;
  private readonly tokenBuf: Buffer;
  private readonly maxBodyBytes: number;
  private server: ReturnType<typeof createHttpServer> | null = null;

  constructor(deps: ReceiverDeps) {
    this.deps = deps;
    this.tokenBuf = Buffer.from(deps.token, "utf8");
    this.maxBodyBytes = deps.maxBodyBytes ?? MAX_BODY_BYTES;
  }

  async start(): Promise<void> {
    const handler = (req: IncomingMessage, res: ServerResponse): void => {
      this.handle(req, res).catch((err) => {
        log.error({ err }, "Unhandled receiver error.");
        if (!res.headersSent) this.respond(res, 500, { error: "internal error" });
      });
    };

    const { tlsCertPath, tlsKeyPath } = this.deps;
    if (tlsCertPath && tlsKeyPath) {
      this.server = createHttpsServer(
        { cert: readFileSync(tlsCertPath), key: readFileSync(tlsKeyPath) },
        handler,
      );
    } else {
      this.server = createHttpServer(handler);
    }

    const { host, port } = splitBind(this.deps.bind);
    await new Promise<void>((resolve, reject) => {
      const srv = this.server!;
      srv.once("error", reject);
      srv.listen(port, host, () => {
        srv.removeListener("error", reject);
        log.info({ bind: this.deps.bind, tls: !!(tlsCertPath && tlsKeyPath) }, "Audit receiver listening.");
        resolve();
      });
    });
  }

  // The actual bound address, useful for tests that bind to an ephemeral port.
  address(): { host: string; port: number } | null {
    const a = this.server?.address();
    if (a && typeof a === "object") return { host: a.address, port: a.port };
    return null;
  }

  async stop(): Promise<void> {
    const srv = this.server;
    if (!srv) return;
    this.server = null;
    await new Promise<void>((resolve) => {
      srv.close(() => resolve());
      // close() alone waits for every open connection to end on its own, so a
      // client that opened a socket but never finished its request would stall
      // shutdown. Force those sockets closed so the callback fires promptly.
      srv.closeAllConnections?.();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      this.respond(res, 405, { error: "method not allowed" });
      return;
    }
    if (!this.authorized(req)) {
      // Do not reveal whether the path/shape was otherwise valid.
      this.respond(res, 401, { error: "unauthorized" });
      return;
    }

    let body: string;
    try {
      body = await this.readBody(req);
    } catch (err) {
      if ((err as Error).message === "body too large") {
        this.respond(res, 413, { error: "payload too large" });
      } else {
        this.respond(res, 400, { error: "could not read body" });
      }
      return;
    }
    if (!body.trim()) {
      this.respond(res, 400, { error: "empty body" });
      return;
    }

    const contentType = (req.headers["content-type"] || "").toLowerCase();
    const tally = this.ingestBody(body, contentType);

    if (tally.posted + tally.filtered + tally.dropped === 0 && tally.bad > 0) {
      // Nothing was usable — signal the sender its payload was malformed.
      this.respond(res, 400, { error: "no valid events", ...tally });
      return;
    }
    if (tally.dropped > 0) {
      // Backpressure: the send queue was full, so some events could not be
      // accepted. A 2xx here would let the shipper ack and advance past audit
      // records we never posted (permanent loss, precisely at peak volume).
      // Return 503 + Retry-After so it holds the batch and re-sends. Re-sending
      // may re-post the already-accepted events in the same batch, but this
      // firehose does no dedup and tolerates duplicates; silent loss is worse.
      this.respond(res, 503, { error: "queue full, retry", ...tally }, { "retry-after": String(RETRY_AFTER_SECONDS) });
      return;
    }
    this.respond(res, 202, { ok: true, ...tally });
  }

  private ingestBody(body: string, contentType: string): IngestTally {
    const tally: IngestTally = { posted: 0, filtered: 0, dropped: 0, bad: 0 };
    const record = (o: IngestOutcome): void => {
      tally[o]++;
    };

    if (contentType.includes("cloudevents")) {
      // Opt-in CloudEvents wrapping (single or batch); data is the OCSF object.
      for (const item of parseCloudEventsBody(body, contentType)) {
        if (item.ok) record(this.deps.ingest(item.data, item.type));
        else {
          tally.bad++;
          log.warn({ error: item.error }, "Quarantined malformed CloudEvent.");
        }
      }
      return tally;
    }

    const trimmed = body.trim();
    if (trimmed.startsWith("[")) {
      // A JSON array of bare OCSF objects.
      let arr: unknown;
      try {
        arr = JSON.parse(trimmed);
      } catch {
        tally.bad++;
        log.warn("Quarantined unparseable JSON array body.");
        return tally;
      }
      if (!Array.isArray(arr)) {
        tally.bad++;
        return tally;
      }
      for (const obj of arr) record(this.deps.ingest(obj));
      return tally;
    }

    // Default: NDJSON — one bare OCSF object per line. This is what a log-shipper
    // pointed at the JSONL file sends. Blank lines are skipped; a bad line is
    // quarantined without poisoning the rest of the batch.
    for (const line of trimmed.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(s);
      } catch {
        tally.bad++;
        log.warn("Quarantined unparseable NDJSON line.");
        continue;
      }
      record(this.deps.ingest(obj));
    }
    return tally;
  }

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers["authorization"];
    if (typeof header !== "string") return false;
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!m) return false;
    const presented = Buffer.from(m[1], "utf8");
    // Length-safe constant-time compare: timingSafeEqual throws on length
    // mismatch, so guard it (the length check itself is not secret).
    if (presented.length !== this.tokenBuf.length) return false;
    return timingSafeEqual(presented, this.tokenBuf);
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let done = false;
      req.on("data", (chunk: Buffer) => {
        if (done) return; // already over the limit; ignore the rest of the body
        total += chunk.length;
        if (total > this.maxBodyBytes) {
          // Reject but do NOT destroy the socket, so the caller can still send a
          // 413 response instead of the client seeing a dropped connection.
          done = true;
          reject(new Error("body too large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (!done) resolve(Buffer.concat(chunks).toString("utf8"));
      });
      req.on("error", reject);
    });
  }

  private respond(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(payload);
  }
}

// Split "host:port" (with optional [ipv6] brackets) into parts. A bare port or a
// missing host binds all interfaces.
export function splitBind(bind: string): { host: string; port: number } {
  const v6 = /^\[(.+)\]:(\d+)$/.exec(bind);
  if (v6) return { host: v6[1], port: Number(v6[2]) };
  const idx = bind.lastIndexOf(":");
  if (idx === -1) return { host: "0.0.0.0", port: Number(bind) };
  const host = bind.slice(0, idx) || "0.0.0.0";
  const port = Number(bind.slice(idx + 1));
  return { host, port };
}

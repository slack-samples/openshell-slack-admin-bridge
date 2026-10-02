import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Receiver, splitBind } from "../../src/capture/receiver";
import { createIngestor, type AuditSink } from "../../src/capture/pipeline";
import type { RenderedAudit } from "../../src/capture/blocks";

const TOKEN = "s3cret-token";

// Apache-2.0 example from NVIDIA/OpenShell-Research PR #66, commit
// 116fb82adad70a37c2669143e278e31c5e343895; see fixture README for provenance.
const researchEvent = JSON.parse(readFileSync(
  join(__dirname, "../fixtures/research-exporter/ocsf-network-denial.json"), "utf8",
));

test("Research exporter batch reaches Slack rendering with sandbox identity and source detail", async () => {
  await withReceiver(async ({ url, posted }) => {
    const res = await post(url, JSON.stringify([researchEvent]), {
      "content-type": "application/cloudevents-batch+json",
    });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { ok: true, posted: 1, filtered: 0, dropped: 0, bad: 0 });
    assert.equal(posted.length, 1);
    const rendered = JSON.stringify(posted[0]);
    assert.match(rendered, /sandbox-123/);
    assert.match(rendered, /CONNECT denied api\.example\.com:443/);
    assert.match(rendered, /request-123/);
    assert.doesNotMatch(rendered, /observed_time/);
  });
});

test("Research exporter retries are requested when the Slack queue cannot accept a batch", async () => {
  await withReceiver(async ({ url }) => {
    const res = await post(url, JSON.stringify([researchEvent]), {
      "content-type": "application/cloudevents-batch+json",
    });
    assert.equal(res.status, 503);
    assert.equal((await res.json() as { dropped: number }).dropped, 1);
    assert.ok(res.headers.get("retry-after"));
  }, { sink: () => false });
});

interface Harness {
  url: string;
  posted: RenderedAudit[];
  stop: () => Promise<void>;
}

// Stand up a receiver on an ephemeral loopback port, wired to a real ingestor
// whose sink records every message that survives filtering.
async function withReceiver(
  run: (h: Harness) => Promise<void>,
  opts: { maxBodyBytes?: number; sink?: AuditSink } = {},
): Promise<void> {
  const posted: RenderedAudit[] = [];
  const sink: AuditSink = opts.sink ?? ((m) => (posted.push(m), true));
  const ingest = createIngestor([], sink);
  const receiver = new Receiver({
    bind: "127.0.0.1:0",
    token: TOKEN,
    ingest,
    maxBodyBytes: opts.maxBodyBytes,
  });
  await receiver.start();
  const addr = receiver.address();
  assert.ok(addr, "receiver should report its bound address");
  const url = `http://127.0.0.1:${addr!.port}/`;
  try {
    await run({ url, posted, stop: () => receiver.stop() });
  } finally {
    await receiver.stop();
  }
}

function post(url: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/x-ndjson", ...headers },
    body,
  });
}

const OCSF = (n: number): string => JSON.stringify({ class_name: "Process Activity", activity_name: `a${n}`, message: `m${n}` });

test("rejects a request with no bearer token (401)", async () => {
  await withReceiver(async ({ url, posted }) => {
    const res = await fetch(url, { method: "POST", body: OCSF(1) });
    assert.equal(res.status, 401);
    assert.equal(posted.length, 0);
  });
});

test("rejects a request with the wrong bearer token (401)", async () => {
  await withReceiver(async ({ url, posted }) => {
    const res = await post(url, OCSF(1), { authorization: "Bearer nope" });
    assert.equal(res.status, 401);
    assert.equal(posted.length, 0);
  });
});

test("rejects a non-POST method (405)", async () => {
  await withReceiver(async ({ url }) => {
    const res = await fetch(url, { method: "GET", headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 405);
  });
});

test("accepts NDJSON of bare OCSF objects (202) and ingests each", async () => {
  await withReceiver(async ({ url, posted }) => {
    const res = await post(url, `${OCSF(1)}\n${OCSF(2)}\n\n`); // trailing blank line skipped
    assert.equal(res.status, 202);
    const body = (await res.json()) as { posted: number };
    assert.equal(body.posted, 2);
    assert.equal(posted.length, 2);
    assert.match(posted[0].text, /a1/);
    assert.match(posted[1].text, /a2/);
  });
});

test("accepts a JSON array of bare OCSF objects (202)", async () => {
  await withReceiver(async ({ url, posted }) => {
    const res = await post(url, `[${OCSF(1)},${OCSF(2)}]`, { "content-type": "application/json" });
    assert.equal(res.status, 202);
    assert.equal(posted.length, 2);
  });
});

test("accepts a CloudEvents envelope and unwraps its data (202)", async () => {
  await withReceiver(async ({ url, posted }) => {
    const envelope = JSON.stringify({
      specversion: "1.0",
      id: "evt-1",
      source: "openshell",
      type: "com.openshell.ocsf.process_activity",
      data: { class_name: "Process Activity", activity_name: "Launch", message: "ce-body" },
    });
    const res = await post(url, envelope, { "content-type": "application/cloudevents+json" });
    assert.equal(res.status, 202);
    assert.equal(posted.length, 1);
    assert.match(posted[0].text, /Process Activity/);
  });
});

test("a malformed-only body is reported as 400", async () => {
  await withReceiver(async ({ url, posted }) => {
    const res = await post(url, "{not json{");
    assert.equal(res.status, 400);
    assert.equal(posted.length, 0);
  });
});

test("an empty body is rejected (400)", async () => {
  await withReceiver(async ({ url }) => {
    const res = await post(url, "   ");
    assert.equal(res.status, 400);
  });
});

test("a body over the size limit is rejected (413)", async () => {
  await withReceiver(
    async ({ url, posted }) => {
      const res = await post(url, "x".repeat(200));
      assert.equal(res.status, 413);
      assert.equal(posted.length, 0);
    },
    { maxBodyBytes: 50 },
  );
});

test("a full send queue is refused with 503 + Retry-After so the shipper retries", async () => {
  // sink returns false for every event (queue full). The receiver must NOT 202
  // and let the shipper advance past audit records that never reached Slack.
  await withReceiver(
    async ({ url }) => {
      const res = await post(url, `${OCSF(1)}\n${OCSF(2)}\n`);
      assert.equal(res.status, 503);
      assert.ok(res.headers.get("retry-after"), "should hint a retry delay");
      const body = (await res.json()) as { dropped: number; posted: number };
      assert.equal(body.dropped, 2);
      assert.equal(body.posted, 0);
    },
    { sink: () => false },
  );
});

test("one bad NDJSON line does not poison the good ones", async () => {
  await withReceiver(async ({ url, posted }) => {
    const res = await post(url, `${OCSF(1)}\n{bad\n${OCSF(2)}\n`);
    assert.equal(res.status, 202);
    const body = (await res.json()) as { posted: number; bad: number };
    assert.equal(body.posted, 2);
    assert.equal(body.bad, 1);
    assert.equal(posted.length, 2);
  });
});

// ---- splitBind unit coverage -------------------------------------------

test("splitBind parses host:port, bare port, and bracketed IPv6", () => {
  assert.deepEqual(splitBind("0.0.0.0:8090"), { host: "0.0.0.0", port: 8090 });
  assert.deepEqual(splitBind("127.0.0.1:9999"), { host: "127.0.0.1", port: 9999 });
  assert.deepEqual(splitBind("8090"), { host: "0.0.0.0", port: 8090 });
  assert.deepEqual(splitBind("[::1]:8090"), { host: "::1", port: 8090 });
});

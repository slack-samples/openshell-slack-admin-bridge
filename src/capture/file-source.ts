// Tail OpenShell's OCSF JSONL file(s) and emit one complete line at a time.
//
// OpenShell writes OCSF as line-delimited JSON to a local rolling file (see the
// openshell-ocsf-egress note); this is the native, auth-free ingestion path. We
// poll rather than fs.watch so the same code works over a bind mount, an NFS
// share, or a centrally aggregated copy, none of which deliver reliable inotify.
//
// Guarantees:
//  - Complete lines only: a partial trailing line (write in progress) is left
//    until its newline arrives.
//  - Resumable: the byte offset is persisted per file identity (device+inode),
//    so a restart continues where it left off without re-posting or skipping.
//  - Tail-from-now on a COLD start only: with no persisted offsets, a file that
//    already exists starts at its end, so we do not replay a huge historical
//    backlog into Slack. On a WARM restart (offsets present) a file we have not
//    seen before, e.g. one that rotated in while the daemon was down, is read
//    from the beginning so those events are not lost. A file that appears while
//    we are watching is likewise read in full.
//  - Rotation-safe for create-new rotation: OpenShell rotates by writing a new
//    dated file (new inode), which is picked up as a fresh offset entry, and an
//    in-place shrink (size < stored offset) resets that file's offset. NOTE: a
//    copytruncate-style rotate that truncates a file in place and then refills
//    PAST the old offset within a single poll interval is NOT detected (it needs
//    content comparison, not just size). OpenShell does not use copytruncate, so
//    this is a documented, accepted gap rather than a live risk.

import { openSync, fstatSync, readSync, closeSync, existsSync, globSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { childLogger } from "../logger";

const log = childLogger("capture-file");

const MAX_READ_BYTES = 4 * 1024 * 1024; // per file, per poll; catch-up spans polls
const NEWLINE = 0x0a;

interface FileState {
  path: string;
  offset: number;
  // Set while skipping the tail of a line longer than the read window, so its
  // trailing fragment (up to the next newline) is discarded, not emitted.
  skipUntilNewline?: boolean;
}
interface OffsetFile {
  version: 1;
  files: Record<string, FileState>;
}

export interface FileSourceDeps {
  // A path or glob for the OCSF JSONL file(s).
  path: string;
  // Where to persist per-file byte offsets.
  offsetStatePath: string;
  // Called for each complete (newline-terminated) line, without the newline.
  onLine: (line: string) => void;
  pollIntervalMs?: number;
  // Max bytes read per file per poll; also the largest single line we can emit.
  // Injectable so tests can exercise the oversized-line path without huge files.
  maxReadBytes?: number;
}

export class FileSource {
  private readonly path: string;
  private readonly offsetStatePath: string;
  private readonly onLine: (line: string) => void;
  private readonly pollIntervalMs: number;
  private readonly maxReadBytes: number;
  // True when we started with no persisted offsets at all (a genuine cold
  // start). Distinguishes cold start from a warm restart: on a cold start an
  // already-present file is tailed from its end; on a warm restart an
  // unknown/rotated-in file is read from the beginning so events written while
  // we were down are not skipped.
  private readonly coldStart: boolean;

  private state: OffsetFile;
  private started = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private warnedMissing = false;

  constructor(deps: FileSourceDeps) {
    this.path = deps.path;
    this.offsetStatePath = deps.offsetStatePath;
    this.onLine = deps.onLine;
    this.pollIntervalMs = deps.pollIntervalMs ?? 1000;
    this.maxReadBytes = deps.maxReadBytes ?? MAX_READ_BYTES;
    this.state = this.loadState();
    this.coldStart = Object.keys(this.state.files).length === 0;
  }

  start(): void {
    if (this.timer) return;
    // Prime once synchronously so tail-from-now offsets are recorded immediately,
    // then poll on an interval. The timer is intentionally NOT unref'd: when the
    // file is the only source, it is what keeps this daemon alive between polls.
    this.pollOnce();
    this.timer = setInterval(() => this.pollOnce(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // One tail pass over every currently-matched file. Public for deterministic
  // testing (drive it directly instead of waiting on the interval).
  pollOnce(): void {
    let files: string[];
    try {
      files = this.resolveFiles();
    } catch (err) {
      log.warn({ err, path: this.path }, "Failed to resolve OCSF log path.");
      return;
    }

    if (files.length === 0) {
      if (!this.warnedMissing) {
        log.warn({ path: this.path }, "No OCSF log file matches yet; waiting for it to appear.");
        this.warnedMissing = true;
      }
      this.started = true;
      return;
    }
    this.warnedMissing = false;

    let dirty = false;
    // Sort for a stable, roughly chronological order across a rotated set.
    for (const file of files.sort()) {
      try {
        if (this.processFile(file)) dirty = true;
      } catch (err) {
        log.warn({ err, file }, "Failed to read OCSF log file this cycle.");
      }
    }
    this.pruneMissing();
    this.started = true;
    if (dirty) this.persist();
  }

  stats(): { files: number } {
    return { files: Object.keys(this.state.files).length };
  }

  private resolveFiles(): string[] {
    // globSync handles a literal path as a single-match pattern too, but a bare
    // existing path is the common case and avoids surprising glob metacharacters.
    if (existsSync(this.path)) return [this.path];
    return globSync(this.path).filter((p) => existsSync(p));
  }

  // Returns true if this file's persisted state changed (needs writing out).
  private processFile(file: string): boolean {
    const fd = openSync(file, "r");
    try {
      const st = fstatSync(fd);
      const key = `${st.dev}-${st.ino}`;
      let entry = this.state.files[key];
      let changed = false;
      if (!entry) {
        // Choose this file's starting offset:
        //  - Tail-from-now (st.size) ONLY for a file already present on the very
        //    first poll of a genuine COLD start, so we don't replay history.
        //  - Read from the beginning (0) otherwise: a file that appears while
        //    watching, OR any unknown file seen on a WARM restart (e.g. one that
        //    rotated in while we were down) — those events must not be skipped.
        const tailFromNow = !this.started && this.coldStart;
        entry = { path: file, offset: tailFromNow ? st.size : 0 };
        this.state.files[key] = entry;
        changed = true;
      }
      if (entry.path !== file) {
        entry.path = file; // same inode, rotated name: keep the current path
        changed = true;
      }

      const size = st.size;
      if (size < entry.offset) {
        // Shrank below our offset: truncated or replaced in place. Restart from
        // the top of this inode. (A copytruncate that refills PAST the old
        // offset within one poll is not detectable by size alone; see the file
        // header — OpenShell does not use copytruncate, so this is accepted.)
        log.info({ file, was: entry.offset, size }, "OCSF log file truncated; resetting offset.");
        entry.offset = 0;
        entry.skipUntilNewline = false; // any prior mid-skip is void after a reset
        changed = true;
      }
      if (size <= entry.offset) return changed;

      const toRead = Math.min(size - entry.offset, this.maxReadBytes);
      const buf = Buffer.allocUnsafe(toRead);
      const bytesRead = readSync(fd, buf, 0, toRead, entry.offset);
      const chunk = buf.subarray(0, bytesRead);

      const lastNl = chunk.lastIndexOf(NEWLINE);
      if (lastNl === -1) {
        if (bytesRead >= this.maxReadBytes) {
          // A single line longer than the read window would stall the tailer.
          // Skip this window and remember we are mid-skip, so the eventual tail
          // of the oversized line (up to its newline) is discarded rather than
          // emitted as a spurious truncated fragment.
          log.warn({ file, bytes: bytesRead }, "OCSF log line exceeds read window; skipping oversized fragment.");
          entry.offset += bytesRead;
          entry.skipUntilNewline = true;
          return true;
        }
        // Partial trailing line still being written; wait for its newline.
        return changed;
      }

      // Consume the whole chunk up to the last newline. If we were mid-skip of an
      // oversized line, drop everything up to and including the FIRST newline
      // (the discarded line's tail) before emitting; then resume normally.
      let emitFrom = 0;
      if (entry.skipUntilNewline) {
        emitFrom = chunk.indexOf(NEWLINE) + 1;
        entry.skipUntilNewline = false;
      }
      entry.offset += lastNl + 1;
      const complete = chunk.subarray(emitFrom, lastNl + 1).toString("utf8");
      for (const line of complete.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) this.onLine(trimmed);
      }
      return true;
    } finally {
      closeSync(fd);
    }
  }

  // Drop offset entries for files that no longer exist, so daily rotation does
  // not grow the state file without bound.
  private pruneMissing(): void {
    for (const [key, entry] of Object.entries(this.state.files)) {
      if (!existsSync(entry.path)) delete this.state.files[key];
    }
  }

  private loadState(): OffsetFile {
    if (!existsSync(this.offsetStatePath)) return { version: 1, files: {} };
    try {
      const parsed = JSON.parse(readFileUtf8(this.offsetStatePath)) as OffsetFile;
      if (parsed && parsed.files && typeof parsed.files === "object") {
        return { version: 1, files: parsed.files };
      }
    } catch (err) {
      // A corrupt offset file must not crash the sink; start fresh (tail-from-now)
      // rather than re-reading everything or dying.
      log.warn({ err, path: this.offsetStatePath }, "Offset state unreadable; starting fresh.");
    }
    return { version: 1, files: {} };
  }

  private persist(): void {
    const dir = dirname(this.offsetStatePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.offsetStatePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), "utf8");
    renameSync(tmp, this.offsetStatePath);
  }
}

function readFileUtf8(p: string): string {
  const fd = openSync(p, "r");
  try {
    const st = fstatSync(fd);
    const buf = Buffer.allocUnsafe(st.size);
    const n = readSync(fd, buf, 0, st.size, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

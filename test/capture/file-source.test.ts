import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileSource } from "../../src/capture/file-source";

// Each test gets its own throwaway directory holding the log file and the
// offset-state file, so nothing leaks between cases.
function withDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "capture-file-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeSource(dir: string, file: string, lines: string[]): FileSource {
  return new FileSource({
    path: file,
    offsetStatePath: join(dir, "offsets.json"),
    onLine: (l) => lines.push(l),
  });
}

test("emits complete lines appended after the first poll", () => {
  withDir((dir) => {
    const file = join(dir, "ocsf.log");
    writeFileSync(file, "");
    const lines: string[] = [];
    const src = makeSource(dir, file, lines);

    src.pollOnce(); // establishes the tail-from-now baseline (empty file → 0)
    appendFileSync(file, '{"a":1}\n{"a":2}\n');
    src.pollOnce();

    assert.deepEqual(lines, ['{"a":1}', '{"a":2}']);
  });
});

test("does not replay a pre-existing backlog on cold start (tail-from-now)", () => {
  withDir((dir) => {
    const file = join(dir, "ocsf.log");
    writeFileSync(file, "old-1\nold-2\n"); // history present before we watch
    const lines: string[] = [];
    const src = makeSource(dir, file, lines);

    src.pollOnce(); // baseline jumps to the current end
    assert.deepEqual(lines, []);

    appendFileSync(file, "new-1\n");
    src.pollOnce();
    assert.deepEqual(lines, ["new-1"]);
  });
});

test("buffers a partial trailing line until its newline arrives", () => {
  withDir((dir) => {
    const file = join(dir, "ocsf.log");
    writeFileSync(file, "");
    const lines: string[] = [];
    const src = makeSource(dir, file, lines);

    src.pollOnce();
    appendFileSync(file, "partial");
    src.pollOnce();
    assert.deepEqual(lines, []); // no newline yet

    appendFileSync(file, "-rest\n");
    src.pollOnce();
    assert.deepEqual(lines, ["partial-rest"]);
  });
});

test("resumes from the persisted offset across a restart", () => {
  withDir((dir) => {
    const file = join(dir, "ocsf.log");
    writeFileSync(file, "");
    const l1: string[] = [];
    const src1 = makeSource(dir, file, l1);
    src1.pollOnce();
    appendFileSync(file, "one\n");
    src1.pollOnce();
    assert.deepEqual(l1, ["one"]);

    // A fresh instance sharing the offset-state file must continue, not replay.
    const l2: string[] = [];
    const src2 = makeSource(dir, file, l2);
    appendFileSync(file, "two\n");
    src2.pollOnce();
    assert.deepEqual(l2, ["two"]);
  });
});

test("detects in-place truncation and re-reads from the top", () => {
  withDir((dir) => {
    const file = join(dir, "ocsf.log");
    writeFileSync(file, "");
    const lines: string[] = [];
    const src = makeSource(dir, file, lines);
    src.pollOnce();
    appendFileSync(file, "aaaa\n");
    src.pollOnce();
    assert.deepEqual(lines, ["aaaa"]);

    // Rewrite smaller so the new size is below the stored offset.
    writeFileSync(file, "bb\n");
    src.pollOnce();
    assert.deepEqual(lines, ["aaaa", "bb"]);
  });
});

test("tolerates a not-yet-present file and reads it fully once it appears", () => {
  withDir((dir) => {
    const file = join(dir, "later.log");
    const lines: string[] = [];
    const src = makeSource(dir, file, lines);

    assert.doesNotThrow(() => src.pollOnce()); // missing file: log-and-wait
    assert.deepEqual(lines, []);

    // A file born after we start watching is read from the beginning, not tailed.
    writeFileSync(file, "first\nsecond\n");
    src.pollOnce();
    assert.deepEqual(lines, ["first", "second"]);
  });
});

test("on a warm restart, a file that rotated in during downtime is read from the start", () => {
  withDir((dir) => {
    // Cold start on file A: tail-from-now, then read one appended line so the
    // offset state file is written (marking this a "warm" restart hereafter).
    const a = join(dir, "ocsf.1.log");
    writeFileSync(a, "history\n");
    const l1: string[] = [];
    const src1 = new FileSource({
      path: join(dir, "ocsf.*.log"),
      offsetStatePath: join(dir, "offsets.json"),
      onLine: (l) => l1.push(l),
    });
    src1.pollOnce(); // tails A from its end
    appendFileSync(a, "a-live\n");
    src1.pollOnce();
    assert.deepEqual(l1, ["a-live"]);

    // While "down", a new dated file B rotates in (new inode) with events that
    // were written before the fresh instance's first poll. A warm restart must
    // read B from the beginning, not tail it and lose those events.
    const b = join(dir, "ocsf.2.log");
    writeFileSync(b, "b-1\nb-2\n");

    const l2: string[] = [];
    const src2 = new FileSource({
      path: join(dir, "ocsf.*.log"),
      offsetStatePath: join(dir, "offsets.json"),
      onLine: (l) => l2.push(l),
    });
    src2.pollOnce();
    assert.deepEqual(l2, ["b-1", "b-2"]); // A resumes (nothing new); B read in full
  });
});

test("suppresses the trailing fragment of an over-long line and resumes cleanly", () => {
  withDir((dir) => {
    const file = join(dir, "ocsf.log");
    writeFileSync(file, "");
    const lines: string[] = [];
    const src = new FileSource({
      path: file,
      offsetStatePath: join(dir, "offsets.json"),
      onLine: (l) => lines.push(l),
      maxReadBytes: 8, // tiny window so a modest line counts as "oversized"
    });

    src.pollOnce(); // baseline at 0
    // A 20-byte line (longer than the 8-byte window) followed by a good line.
    appendFileSync(file, `${"x".repeat(20)}\nok\n`);

    // Drive several polls: each skips one 8-byte window of the oversized line,
    // then the window containing its newline + the good line is reached.
    src.pollOnce();
    src.pollOnce();
    src.pollOnce();

    // The oversized line's fragment must NOT be emitted; only the good line is.
    assert.deepEqual(lines, ["ok"]);
  });
});

test("follows a glob across multiple files in a stable order", () => {
  withDir((dir) => {
    const a = join(dir, "ocsf.1.log");
    const b = join(dir, "ocsf.2.log");
    writeFileSync(a, "");
    writeFileSync(b, "");
    const lines: string[] = [];
    const src = new FileSource({
      path: join(dir, "ocsf.*.log"),
      offsetStatePath: join(dir, "offsets.json"),
      onLine: (l) => lines.push(l),
    });

    src.pollOnce();
    appendFileSync(a, "a1\n");
    appendFileSync(b, "b1\n");
    src.pollOnce();
    assert.deepEqual(lines, ["a1", "b1"]); // sorted: file 1 before file 2
  });
});

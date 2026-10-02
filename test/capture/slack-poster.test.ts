import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createSlackPoster } from "../../src/capture/slack-poster";

for (const status of [200, 429, 500]) {
  test(`capture owns retries and reports only confirmed Slack receipts (HTTP ${status})`, async () => {
    let requests = 0;
    const receipts: unknown[] = [];
    const server = createServer((req, res) => {
      requests++;
      req.resume();
      const responseStatus = requests === 1 ? status : 200;
      res.writeHead(responseStatus, { "content-type": "application/json", "retry-after": "1" });
      res.end(JSON.stringify(responseStatus === 200
        ? { ok: true, channel: "C123", ts: "123.456" }
        : { ok: false, error: status === 429 ? "ratelimited" : "internal_error" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    try {
      const post = createSlackPoster("test-only", "C123", (receipt) => receipts.push(receipt),
        `http://127.0.0.1:${address.port}/`);
      if (status === 200) {
        await post({ text: "test audit", blocks: [] });
        assert.deepEqual(receipts, [{ channel: "C123", ts: "123.456" }]);
      } else {
        await assert.rejects(post({ text: "test audit", blocks: [] }));
        assert.deepEqual(receipts, []);
      }
      assert.equal(requests, 1, "the SDK must not hide retries from SendQueue");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

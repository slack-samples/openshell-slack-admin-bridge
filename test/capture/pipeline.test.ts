import { test } from "node:test";
import assert from "node:assert/strict";
import { renderOcsfObject, createIngestor } from "../../src/capture/pipeline";
import type { RenderedAudit } from "../../src/capture/blocks";

const PROC_EVENT = {
  class_name: "Process Activity",
  class_uid: 1007,
  activity_name: "Launch",
  type_name: "Process Activity: Launch",
  severity: "Informational",
  severity_id: 1,
  message: "ran whoami",
};

test("renderOcsfObject renders an event that passes the filter", () => {
  const rendered = renderOcsfObject(PROC_EVENT, []);
  assert.ok(rendered, "expected a rendered message");
  assert.match(rendered!.text, /Process Activity: Launch/);
  assert.ok(rendered!.blocks.length > 0);
});

test("renderOcsfObject returns null for a filtered event", () => {
  assert.equal(renderOcsfObject(PROC_EVENT, ["Process Activity"]), null);
});

test("renderOcsfObject can filter on the CloudEvents type", () => {
  const t = "com.openshell.ocsf.process_activity";
  assert.equal(renderOcsfObject(PROC_EVENT, [t], t), null);
  // A non-matching CloudEvents type leaves the event captured.
  assert.ok(renderOcsfObject(PROC_EVENT, ["something.else"], t));
});

test("ingestor reports 'posted' when the sink accepts the message", () => {
  const seen: RenderedAudit[] = [];
  const ingest = createIngestor([], (m) => {
    seen.push(m);
    return true;
  });
  assert.equal(ingest(PROC_EVENT), "posted");
  assert.equal(seen.length, 1);
  assert.match(seen[0].text, /Process Activity/);
});

test("ingestor reports 'filtered' and never touches the sink", () => {
  let calls = 0;
  const ingest = createIngestor(["Process Activity"], () => {
    calls++;
    return true;
  });
  assert.equal(ingest(PROC_EVENT), "filtered");
  assert.equal(calls, 0);
});

test("ingestor reports 'dropped' when the sink rejects (queue full)", () => {
  const ingest = createIngestor([], () => false);
  assert.equal(ingest(PROC_EVENT), "dropped");
});

test("ingestor is tolerant of a non-object OCSF payload", () => {
  // normalizeOcsf coerces junk into an "Unknown" event rather than throwing, so
  // the pipeline still produces a message instead of crashing a source.
  const seen: RenderedAudit[] = [];
  const ingest = createIngestor([], (m) => {
    seen.push(m);
    return true;
  });
  assert.equal(ingest(null), "posted");
  assert.equal(ingest("not-an-object"), "posted");
  assert.equal(seen.length, 2);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCloudEventsBody, parseEnvelope } from "../../src/capture/cloudevents";

const OCSF = { class_uid: 4001, class_name: "Network Activity", severity: "Medium" };

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    specversion: "1.0",
    id: "evt-1",
    source: "openshell/sandbox-abc123",
    type: "com.openshell.ocsf.network_activity",
    time: "2026-08-30T00:00:00Z",
    datacontenttype: "application/json",
    data: OCSF,
    ...overrides,
  };
}

test("parses a single structured envelope and extracts context attributes", () => {
  const [item] = parseCloudEventsBody(JSON.stringify(envelope()), "application/cloudevents+json");
  assert.equal(item.ok, true);
  if (!item.ok) return;
  assert.equal(item.type, "com.openshell.ocsf.network_activity");
  assert.equal(item.id, "evt-1");
  assert.equal(item.source, "openshell/sandbox-abc123");
  assert.equal(item.time, "2026-08-30T00:00:00Z");
  assert.deepEqual(item.data, OCSF);
});

test("parses a batch array into one item per envelope", () => {
  const body = JSON.stringify([envelope({ id: "a" }), envelope({ id: "b" })]);
  const items = parseCloudEventsBody(body, "application/cloudevents-batch+json");
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.ok));
});

test("an array body is treated as a batch even without the batch content-type", () => {
  const items = parseCloudEventsBody(JSON.stringify([envelope()]), undefined);
  assert.equal(items.length, 1);
  assert.equal(items[0].ok, true);
});

test("a batch content-type with a non-array body is quarantined", () => {
  const [item] = parseCloudEventsBody(JSON.stringify(envelope()), "application/cloudevents-batch+json");
  assert.equal(item.ok, false);
  if (item.ok) return;
  assert.match(item.error, /not a JSON array/);
});

test("decodes a data_base64 payload", () => {
  const b64 = Buffer.from(JSON.stringify(OCSF), "utf8").toString("base64");
  const [item] = parseCloudEventsBody(JSON.stringify(envelope({ data: undefined, data_base64: b64 })));
  assert.equal(item.ok, true);
  if (!item.ok) return;
  assert.deepEqual(item.data, OCSF);
});

test("parses a data attribute that was itself stringified JSON", () => {
  const [item] = parseCloudEventsBody(JSON.stringify(envelope({ data: JSON.stringify(OCSF) })));
  assert.equal(item.ok, true);
  if (!item.ok) return;
  assert.deepEqual(item.data, OCSF);
});

test("keeps a plain (non-JSON) string data payload as-is", () => {
  const [item] = parseCloudEventsBody(JSON.stringify(envelope({ data: "just text" })));
  assert.equal(item.ok, true);
  if (!item.ok) return;
  assert.equal(item.data, "just text");
});

test("quarantines an envelope missing the required type attribute", () => {
  const [item] = parseCloudEventsBody(JSON.stringify(envelope({ type: undefined })));
  assert.equal(item.ok, false);
  if (item.ok) return;
  assert.match(item.error, /missing required CloudEvents attribute: type/);
  // The full offending envelope is preserved for triage (minus the absent type,
  // which JSON.stringify drops).
  assert.deepEqual(item.raw, {
    specversion: "1.0",
    id: "evt-1",
    source: "openshell/sandbox-abc123",
    time: "2026-08-30T00:00:00Z",
    datacontenttype: "application/json",
    data: OCSF,
  });
});

test("quarantines a non-object envelope inside a batch without dropping siblings", () => {
  const body = JSON.stringify([envelope({ id: "ok" }), 42]);
  const items = parseCloudEventsBody(body, "application/cloudevents-batch+json");
  assert.equal(items.length, 2);
  assert.equal(items[0].ok, true);
  const bad = items[1];
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.match(bad.error, /not a JSON object/);
  assert.equal(bad.raw, 42);
});

test("an entirely invalid JSON body yields a single quarantined item with the raw body", () => {
  const [item] = parseCloudEventsBody("{not json", "application/cloudevents+json");
  assert.equal(item.ok, false);
  if (item.ok) return;
  assert.match(item.error, /not valid JSON/);
  assert.equal(item.raw, "{not json");
});

test("parseEnvelope is reusable for binary-mode assembly", () => {
  const item = parseEnvelope({ type: "x", data: OCSF });
  assert.equal(item.ok, true);
  if (!item.ok) return;
  assert.equal(item.type, "x");
  assert.equal(item.id, null);
});

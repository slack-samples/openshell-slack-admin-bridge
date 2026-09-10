import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOcsf } from "../../src/capture/normalize";
import { shouldCapture } from "../../src/capture/filter";

const ev = normalizeOcsf({
  class_name: "HTTP Activity",
  activity_name: "Request",
  type_name: "HTTP Activity: Request",
});

test("an empty exclude list captures everything", () => {
  assert.equal(shouldCapture(ev, []), true);
});

test("excluding by OCSF class_name drops the event (case-insensitive)", () => {
  assert.equal(shouldCapture(ev, ["http activity"]), false);
});

test("excluding by OCSF type_name drops the event", () => {
  assert.equal(shouldCapture(ev, ["HTTP Activity: Request"]), false);
});

test("excluding by CloudEvents type drops the event", () => {
  assert.equal(shouldCapture(ev, ["com.openshell.ocsf.http_activity"], "com.openshell.ocsf.http_activity"), false);
});

test("a non-matching exclude list keeps the event", () => {
  assert.equal(shouldCapture(ev, ["Process Activity", "SSH Activity"]), true);
});

test("matching is exact, not substring: 'HTTP' does not drop 'HTTP Activity'", () => {
  assert.equal(shouldCapture(ev, ["HTTP"]), true);
});

test("blank exclude entries are ignored", () => {
  assert.equal(shouldCapture(ev, ["", "   "]), true);
});

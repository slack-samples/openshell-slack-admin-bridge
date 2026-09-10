import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOcsf, OCSF_BASE_KEYS } from "../../src/capture/normalize";

// A realistic flattened OCSF Network Activity event as it arrives on the wire
// (BaseEventData fields emitted as id+label pairs, class-specific fields
// flattened alongside, plus an `unmapped` bag).
function networkEvent(): Record<string, unknown> {
  return {
    class_uid: 4001,
    class_name: "Network Activity",
    category_uid: 4,
    category_name: "Network Activity",
    activity_id: 6,
    activity_name: "Traffic",
    type_uid: 400106,
    type_name: "Network Activity: Traffic",
    time: 1788100000000,
    severity_id: 3,
    severity: "Medium",
    status_id: 2,
    status: "Failure",
    message: "CONNECT denied evil.example.com:443",
    metadata: {
      version: "1.8.0",
      product: { name: "OpenShell Sandbox Supervisor", vendor_name: "OpenShell" },
      uid: "sandbox-abc123",
    },
    device: { hostname: "sandbox-abc123", os: { name: "Linux" } },
    container: { name: "my-sandbox", uid: "sandbox-abc123", image: { name: "ghcr.io/openshell/sandbox:latest" } },
    dst_endpoint: { hostname: "evil.example.com", port: 443 },
    firewall_rule: { name: "default-deny" },
    unmapped: { policy_version: 7, policy_hash: "deadbeef" },
  };
}

test("normalizeOcsf extracts base fields and the sandbox/container/device context", () => {
  const ev = normalizeOcsf(networkEvent());
  assert.equal(ev.classUid, 4001);
  assert.equal(ev.className, "Network Activity");
  assert.equal(ev.activityName, "Traffic");
  assert.equal(ev.typeName, "Network Activity: Traffic");
  assert.equal(ev.typeUid, 400106);
  assert.equal(ev.timeMs, 1788100000000);
  assert.equal(ev.severityId, 3);
  assert.equal(ev.severity, "Medium");
  assert.equal(ev.statusId, 2);
  assert.equal(ev.status, "Failure");
  assert.equal(ev.message, "CONNECT denied evil.example.com:443");
  assert.equal(ev.sandboxUid, "sandbox-abc123");
  assert.equal(ev.productName, "OpenShell Sandbox Supervisor");
  assert.equal(ev.deviceHostname, "sandbox-abc123");
  assert.deepEqual(ev.container, {
    name: "my-sandbox",
    uid: "sandbox-abc123",
    image: "ghcr.io/openshell/sandbox:latest",
  });
});

test("normalizeOcsf surfaces class-specific fields and the unmapped bag as extra, without base keys", () => {
  const ev = normalizeOcsf(networkEvent());
  assert.deepEqual(ev.extra.dst_endpoint, { hostname: "evil.example.com", port: 443 });
  assert.deepEqual(ev.extra.firewall_rule, { name: "default-deny" });
  // unmapped contents are folded in for the detail view.
  assert.equal(ev.extra.policy_version, 7);
  assert.equal(ev.extra.policy_hash, "deadbeef");
  // No base key leaks into extra.
  for (const k of Object.keys(ev.extra)) {
    assert.equal(OCSF_BASE_KEYS.has(k), false, `extra should not contain base key ${k}`);
  }
});

test("normalizeOcsf tolerates empty, null, and non-object input without throwing", () => {
  for (const bad of [{}, null, undefined, 42, "x", []]) {
    const ev = normalizeOcsf(bad);
    assert.equal(ev.className, "Unknown");
    assert.equal(ev.severity, "Unknown");
    assert.equal(ev.classUid, null);
    assert.equal(ev.message, null);
    // extra is a null-prototype bag; assert emptiness by key count (strict
    // deepEqual against {} would fail on the differing prototype).
    assert.equal(Object.keys(ev.extra).length, 0);
    assert.equal(ev.container, null);
  }
});

test("normalizeOcsf builds type_name from class + activity when it is absent", () => {
  const ev = normalizeOcsf({ class_name: "Process Activity", activity_name: "Launch" });
  assert.equal(ev.typeName, "Process Activity: Launch");
});

test("normalizeOcsf falls back to class_name alone when activity is missing too", () => {
  const ev = normalizeOcsf({ class_name: "Base Event" });
  assert.equal(ev.typeName, "Base Event");
});

test("normalizeOcsf coerces string-typed numeric fields", () => {
  const ev = normalizeOcsf({ class_uid: "4001", time: "1788100000000", severity_id: "4" });
  assert.equal(ev.classUid, 4001);
  assert.equal(ev.timeMs, 1788100000000);
  assert.equal(ev.severityId, 4);
});

test("normalizeOcsf handles a container image given as a bare string", () => {
  const ev = normalizeOcsf({ container: { name: "c", image: "img:tag" } });
  assert.deepEqual(ev.container, { name: "c", uid: null, image: "img:tag" });
});

test("normalizeOcsf preserves class-specific fields named like Object.prototype members without loss", () => {
  // JSON.parse (not an object literal) is required to produce a genuine own
  // "__proto__" key rather than mutating the prototype. A malicious or merely
  // odd sandboxed emitter could ship any of these; none may vanish from extra.
  const input = JSON.parse(
    '{"class_name":"Process Activity","__proto__":{"pwned":1},"toString":"weird","constructor":"c","cmd_line":"whoami"}',
  );
  const ev = normalizeOcsf(input);
  assert.ok(Object.prototype.hasOwnProperty.call(ev.extra, "__proto__"), "__proto__ field preserved as own key");
  assert.deepEqual(ev.extra["__proto__"], { pwned: 1 });
  assert.equal(ev.extra.toString, "weird");
  assert.equal(ev.extra.constructor, "c");
  assert.equal(ev.extra.cmd_line, "whoami");
  // The prototype was not polluted: a fresh object still sees no `pwned`.
  assert.equal(({} as Record<string, unknown>).pwned, undefined);
});

test("normalizeOcsf coerces junk-typed fields to null and falls back on missing enum labels", () => {
  const ev = normalizeOcsf({
    class_uid: "",
    time: "not-a-time",
    severity_id: "high",
    type_uid: {},
  });
  assert.equal(ev.classUid, null);
  assert.equal(ev.timeMs, null);
  assert.equal(ev.severityId, null);
  assert.equal(ev.typeUid, null);
  assert.equal(ev.className, "Unknown");
  assert.equal(ev.severity, "Unknown");
});

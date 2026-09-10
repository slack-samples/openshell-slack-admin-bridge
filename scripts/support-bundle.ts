// Build a share-safe support bundle from the diagnostics log for a Slack support request.
//
// Reads the Tier-2 diagnostics file (DIAGNOSTICS_PATH, default ./state/diagnostics.jsonl),
// runs it through checkShareSafe() as a defense-in-depth gate, and writes the vetted lines to
// an output file the customer can attach. If the safety check fails, it refuses to emit and
// prints the violations so nothing sensitive ever leaves the host.
//
//   npm run support-bundle
//
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkShareSafe } from "../src/diagnostics";

const src = resolve(process.env.DIAGNOSTICS_PATH || "./state/diagnostics.jsonl");
const out = resolve(process.env.SUPPORT_BUNDLE_PATH || "./support-bundle.jsonl");

if (!existsSync(src)) {
  console.error(`No diagnostics file at ${src}.`);
  console.error("The bridge writes diagnostics as issues occur; run it (and reproduce the problem) first,");
  console.error("or set DIAGNOSTICS_PATH to point at the file.");
  process.exit(1);
}

const lines = readFileSync(src, "utf8").split("\n").filter((l) => l.trim() !== "");
if (lines.length === 0) {
  console.error(`Diagnostics file ${src} is empty; nothing to bundle.`);
  process.exit(1);
}

const result = checkShareSafe(lines);
if (!result.ok) {
  console.error("Refusing to write the support bundle: the share-safety check failed.");
  console.error("This is a bug in the bridge's diagnostics, not your config. Please report it.");
  console.error("Violations:");
  for (const v of result.violations.slice(0, 50)) console.error(`  - ${v}`);
  if (result.violations.length > 50) console.error(`  ... and ${result.violations.length - 50} more`);
  process.exit(2);
}

writeFileSync(out, lines.join("\n") + "\n", "utf8");
console.log(`Support bundle written: ${out}`);
console.log(`  ${lines.length} diagnostic ${lines.length === 1 ? "event" : "events"}, all verified share-safe.`);
console.log("  Contains error codes, gRPC/Slack status slugs, counts, and a version fingerprint only.");
console.log("  No tokens, hostnames, channel/user IDs, admin names, file paths, or message text.");
console.log("Attach it to your Slack support request.");

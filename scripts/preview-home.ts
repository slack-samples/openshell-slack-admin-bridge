/**
 * Render the App Home view exactly as the live bridge builds it, but offline: load the durable
 * state, pull pending-chunk detail from the mock gateway (same as reconcile), and print a text
 * dump + block count. No Slack connection. Sandbox-safe (localhost mock + local files only).
 *
 *   SLACK_BOT_TOKEN=x SLACK_APP_TOKEN=x STATE_STORE_PATH=./state/live-run-state.json \
 *   OPENSHELL_USE_TLS=false MOCK_ADDR=127.0.0.1:17670 node --import tsx scripts/preview-home.ts
 *
 * Set HOME_CAROUSEL=false to preview the GA-only fallback view instead of the carousel.
 */
import { loadConfig } from "../src/config";
import { StateStore } from "../src/state-store";
import { OpenShellClient } from "../src/openshell-client";
import { toActionRequest, type ActionRequest } from "../src/action-request";
import { buildAppHomeView } from "../src/app-home";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new StateStore(config.statePath);

  // Rebuild the request-detail cache for pending chunks the way DecisionService.reconcile does.
  const detail = new Map<string, ActionRequest>();
  const client = new OpenShellClient(config.openshell.gatewayUrl, config.openshell.auth, config.defaultWorkspace);
  try {
    for (const sb of await client.listSandboxes(true)) {
      if (!sb.name) continue;
      const resp = await client.getDraftPolicy(sb.name, sb.workspace, "pending");
      for (const c of resp.chunks ?? []) detail.set(c.id, toActionRequest(c, sb));
    }
  } finally {
    client.close();
  }

  // HOME_CAROUSEL=false previews the GA-only fallback (the view the publish path retries with
  // if a carousel-bearing views.publish is rejected); the default previews the carousel.
  const carousel = process.env.HOME_CAROUSEL !== "false";
  const view = buildAppHomeView({ records: store.all(), detail, config, carousel });
  const blocks = view.blocks as unknown as Array<Record<string, unknown>>;

  console.log(carousel ? "(carousel view)\n" : "(GA-only fallback view)\n");
  for (const b of blocks) {
    const type = b.type as string;
    if (type === "divider") {
      console.log("────────────────────────────────────────");
      continue;
    }
    if (type === "carousel") {
      const cards = (b.elements ?? []) as Array<Record<string, { text?: string } | undefined> & {
        actions?: Array<{ text?: { text?: string }; url?: string; style?: string }>;
      }>;
      console.log(`[carousel] ${cards.length} card(s)`);
      for (const c of cards) {
        console.log(`  ┌─ ${c.title?.text ?? ""}`);
        if (c.subtitle?.text) console.log(`  │  ${c.subtitle.text}`);
        for (const line of (c.body?.text ?? "").split("\n")) console.log(`  │  ${line}`);
        const btns = (c.actions ?? []).map((a) => (a.url ? `${a.text?.text} → ${a.url}` : a.text?.text));
        if (btns.length) console.log(`  └─ [ ${btns.join(" ] [ ")} ]`);
      }
      continue;
    }
    if (type === "table") {
      // KPI tile row: print each row's cells pipe-joined so the labels/counts alignment is visible.
      const rows = (b.rows ?? []) as Array<Array<{ text?: string }>>;
      console.log(`[table] ${rows.map((r) => r.map((c) => c.text ?? "").join(" | ")).join("   //   ")}`);
      continue;
    }
    if (type === "data_visualization") {
      // Native chart block (Home-only): print the chart type, title, and each series' points.
      const chart = (b.chart ?? {}) as {
        type?: string;
        series?: Array<{ name?: string; data?: Array<{ label?: string; value?: number }> }>;
      };
      console.log(`[data_visualization] ${(b.title as string) ?? ""}  (${chart.type} chart)`);
      for (const s of chart.series ?? []) {
        const pts = (s.data ?? []).map((d) => `${d.label}=${d.value}`).join("  ");
        console.log(`  • ${s.name}: ${pts}`);
      }
      continue;
    }
    const t = b as { text?: { text?: string }; fields?: { text?: string }[]; elements?: { text?: string }[] };
    // A section can carry either a single text or a `fields` grid (the KPI tiles); dump both.
    const parts = [
      t.text?.text,
      ...(t.fields ?? []).map((f) => f.text),
      ...(t.elements ?? []).map((e) => e.text),
    ].filter(Boolean);
    console.log(`[${type}] ${parts.join("  |  ").replace(/\n/g, " / ")}`);
  }
  console.log(`\n${blocks.length} blocks (limit 100)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

# OpenShell Slack Admin Bridge - Agent-Executable Runbook for Testing

This is the machine-runnable version of the setup: hand it to a coding agent and it can execute it end to end. Every step is one non-interactive command with a precondition and a checkable assertion. There are no browser clicks or interactive shells inside the automated steps; the few things an agent genuinely cannot do are pulled out into "Human inputs" at the top and supplied as values.

It covers both capabilities: the approval flow (Steps 1-8) and the audit-event capture sink (Step 9). Commands are verified against the OpenShell CLI source and the bridge source. Do not paste real tokens into this document.

# Execution contract (read first, agent)

* Run the steps in order. Each step is: **Goal**, **Precheck**, **Run**, **Pass when**, **On failure**.
* A step is done only when its **Pass when** assertion holds. If it fails, do the **On failure** action; if that does not resolve it, STOP and report the failing step, the command, and its full output. Do not continue past a failed gate.
* Every step is idempotent. Re-running the whole runbook must be safe. Idempotency guards are built into the commands (delete-if-exists, `--yes`, read-back).
* Never invent secrets. If a required value from "Human inputs" is missing, STOP and ask for it.
* Assume a POSIX shell. Use `set -o pipefail` where piping. All steps write logs and temp files under `$WORK` (default `/tmp/openshell-bridge`); export `WORK` once per shell to override, or accept the default.
* Do not disable TLS against a real gateway. `OPENSHELL_USE_TLS=false` is for the mock only and is out of scope here.

# Human inputs (an agent cannot produce these; get them once, then everything else is automated)

|What|Why it is human-only|What to hand the agent|
|  ---  |  ---  |  ---  |
|Create the Slack app from `manifest.json`|Browser-only: authenticated Slack web session at api.slack.com/apps -> Create New App -> From a manifest. No API path exists before the app exists.|(the app, created)|
|Bot token `xoxb-...`|Issued only after a human installs the app and approves the OAuth consent for the workspace.|`SLACK_BOT_TOKEN`|
|App-level token `xapp-...` with `connections:write`|Generated only via the Generate button in the app-config UI; no API mint path. Required for Socket Mode.|`SLACK_APP_TOKEN`|
|Invite the bot to the approval channel (`/invite @openshell_admin`)|The app holds only `chat:write` and cannot self-join. Posts to an un-joined channel fail `not_in_channel`.|(bot invited) + the channel ID `C0...`|
|Approval channel ID and admin Slack user IDs|Read from Slack by a human (channel details; member profiles).|`default_channel` = `C0...`; `admins[].slack_user_id` = `U0...`|
|Audit channel ID + bot invited (Step 9 only)|Read from Slack by a human; the bot cannot self-join, and the channel must differ from every approval channel.|`AUDIT_CHANNEL_ID` = `C0...` (distinct from the approval channel)|
|Click Approve / Reject in Slack (real end-to-end test)|Only a genuine click makes Slack mint a trusted interaction payload (`body.user.id`, `trigger_id`). No headless substitute proves the real button; see Step 8 for the programmatic alternative.|(a human clicker, for the true test)|

> [!NOTE]
> The OpenShell gateway credential is NOT a human input in the usual sense: `install.sh` (Step 2) writes the mTLS bundle automatically, and on a single-host no-OIDC gateway that bundle is already an effective admin reviewer. The agent just points the bridge at it.

# Host assumptions

* macOS Apple Silicon (Homebrew present) or Linux x86_64/arm64 with glibc >= 2.28. Intel macOS and Alpine/musl are rejected by the installer.
* A container runtime the gateway can drive (Docker Desktop / Docker Engine 28.0+, or Podman 5.x) is installed and running.
* Node.js 20+ and npm, git, curl, jq available (Step 9 also uses `openssl`). On Linux the install step may require sudo (apt/dnf).
* The bridge repo is `github.com/slack-samples/openshell-slack-admin-bridge`; the runtime it drives is `NVIDIA/OpenShell` (installed via curl below), a separate, unrelated project that happens to share the OpenShell name.

# Step 1 - Preflight

**Goal:** confirm the host can run everything before changing anything.

**Run:**

```
export WORK="${WORK:-/tmp/openshell-bridge}"
set -o pipefail
mkdir -p "$WORK"
node -p "+process.versions.node.split('.')[0] >= 20 ? 'NODE_OK' : 'NODE_BAD'"
npm -v
git --version
jq --version
( docker info >/dev/null 2>&1 && echo RUNTIME_OK ) || ( podman info >/dev/null 2>&1 && echo RUNTIME_OK )
```

**Pass when:** `node -p` prints `NODE_OK`, `npm`/`git`/`jq` print versions, and one of docker/podman prints `RUNTIME_OK`.

**On failure:** install the missing tool; start Docker Desktop / the Docker or Podman daemon. A stopped runtime prints "Cannot connect to the Docker daemon". Do not proceed without a running runtime, or sandboxes will hang in Provisioning.

# Step 2 - Install OpenShell (single host, TLS + mTLS)

**Goal:** install CLI + gateway + managed service; certs auto-generate; gateway registered on `127.0.0.1:17670` (mTLS).

**Precheck (idempotent skip):**

```
openshell status --output json >"$WORK/os_status.json" 2>/dev/null && \
  jq -e '.status=="connected"' "$WORK/os_status.json" >/dev/null && echo ALREADY_INSTALLED
```

If it prints `ALREADY_INSTALLED`, skip the install command and go to the verify below.

**Run:**

```
curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh
```

**Pass when:**

```
openshell status --output json > "$WORK/os_status.json"
jq -e '.status=="connected" and (.authentication.status=="authenticated" or .authentication.status=="not_required")' "$WORK/os_status.json" >/dev/null && echo GATEWAY_OK
test -f "$HOME/.config/openshell/gateways/openshell/mtls/ca.crt" && \
test -f "$HOME/.config/openshell/gateways/openshell/mtls/tls.crt" && \
test -f "$HOME/.config/openshell/gateways/openshell/mtls/tls.key" && echo MTLS_BUNDLE_OK
```

Both `GATEWAY_OK` and `MTLS_BUNDLE_OK` must print. Note: `openshell status` exits 0 even when disconnected, so assert on the JSON fields, not the exit code.

**On failure:** if it aborts about a pre-0.0.37 install, run `openshell sandbox delete --all && openshell gateway destroy` on the old CLI (or re-run with `OPENSHELL_ACK_BREAKING_UPGRADE=1`). On Linux, ensure the systemd user service is up: `systemctl --user restart openshell-gateway` and, for headless hosts, `sudo loginctl enable-linger $USER`. On macOS: `brew services restart openshell`.

# Step 3 - Enable policy proposals and confirm the reviewer credential

**Goal:** turn on draft policy proposals (off by default; the bridge sees nothing without it) and confirm the install-written cert is an admin reviewer.

**Run:**

```
openshell settings set --global --key agent_policy_proposals_enabled --value true --yes
```

**Pass when:**

```
openshell settings get --global --json | jq -e '.settings.agent_policy_proposals_enabled=="true"' >/dev/null && echo PROPOSALS_ON
openshell whoami
```

`PROPOSALS_ON` must print (the value renders as the string `"true"`; if the key is absent it was never set). `openshell whoami` should show subject `openshell-client`, provider `mtls`.

**On failure / notes:** `settings set` is a safe read-modify-write, re-runnable. Always pass `--yes` (without it the global variant blocks on a confirmation prompt). If it returns ABORTED "settings were modified concurrently", retry once. Only if you deliberately configured OIDC on the gateway does the default cert need a grant: `openshell workspace member add --workspace default --subject openshell-client --role admin` (on a local no-OIDC gateway this is unnecessary; the caller is already platform admin).

# Step 4 - Configure the bridge from the human inputs

**Goal:** get the bridge repo, install deps, and write `.env` + `config/admins.yaml` from the supplied values.

**Run (substitute the Human-inputs values; keep tokens out of any committed file):**

```
git clone https://github.com/slack-samples/openshell-slack-admin-bridge.git slack-admin-bridge 2>/dev/null || \
  (cd slack-admin-bridge && git pull)
cd slack-admin-bridge
npm install
npm run build

cat > .env <<EOF
SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}
SLACK_APP_TOKEN=${SLACK_APP_TOKEN}
OPENSHELL_GATEWAY_URL=127.0.0.1:17670
OPENSHELL_AUTH_MODE=mtls
OPENSHELL_USE_TLS=true
OPENSHELL_CA_CERT=\${HOME}/.config/openshell/gateways/openshell/mtls/ca.crt
OPENSHELL_CLIENT_CERT=\${HOME}/.config/openshell/gateways/openshell/mtls/tls.crt
OPENSHELL_CLIENT_KEY=\${HOME}/.config/openshell/gateways/openshell/mtls/tls.key
OPENSHELL_SERVER_NAME=localhost
OPENSHELL_WORKSPACE=default
POLL_INTERVAL_MS=3000
LOG_LEVEL=info
EOF

cat > config/admins.yaml <<EOF
admins:
  - slack_user_id: "${ADMIN_USER_ID}"
    name: "Admin"
    role: "super_admin"
routing:
  default_channel: "${APPROVAL_CHANNEL_ID}"
  workspace_channels:
    default: "${APPROVAL_CHANNEL_ID}"
settings:
  reject_reason_required: true
  destructive_roles: ["super_admin"]
EOF
```

**Pass when:** `npm run build` exits 0, and `.env` + `config/admins.yaml` exist with the real `xoxb`/`xapp` values and a `C0...` `default_channel`.

**On failure:** the bridge throws "Missing required environment variable" if a token is blank, and `loadConfig` throws if `routing.default_channel` is missing. Supply the value and re-run. The bridge discovers sandboxes itself, so no sandbox needs to be listed here.

# Step 5 - Start the bridge headless and verify from logs

**Goal:** run the bridge as a background daemon and confirm Socket Mode + gRPC + reconcile from stdout alone. `node dist/index.js` is a long-running foreground process; there is no run-once mode.

**Run (single-instance guard, then background):**

```
cd slack-admin-bridge
if [ -f "$WORK/bridge.pid" ] && ps -p "$(cat "$WORK/bridge.pid")" >/dev/null 2>&1; then
  kill "$(cat "$WORK/bridge.pid")"; sleep 2
fi
nohup env $(grep -v '^#' .env | xargs) node dist/index.js > "$WORK/bridge.log" 2>&1 &
echo $! > "$WORK/bridge.pid"
sleep 6
```

**Pass when:**

```
grep -F 'Slack Admin Bridge started (Socket Mode).' "$WORK/bridge.log" && echo SOCKET_OK
grep -F 'Reconcile complete.' "$WORK/bridge.log" && echo RECONCILE_OK
grep -F 'Poller started.' "$WORK/bridge.log" && echo POLLER_OK
ps -p "$(cat "$WORK/bridge.pid")" >/dev/null && echo BRIDGE_UP
```

All four must print. `Reconcile complete.` also proves the gRPC `ListSandboxes` + `GetDraftPolicy` calls succeeded over mTLS.

**On failure:** grep the log for `Fatal startup error.` (bad tokens/certs/config), `ListSandboxes failed; skipping cycle.` or `GetDraftPolicy failed; skipping this sandbox.` (gateway unreachable, wrong `OPENSHELL_SERVER_NAME`, or proposals not enabled). Fix and restart. Run exactly ONE instance: the bridge has no cross-process lock, so a second instance double-posts cards and clobbers the state file. Use the pid guard above (or `flock`).

# Step 6 - Produce a real pending policy chunk (non-interactive deny)

**Goal:** trip a real L4 egress denial with no TTY and no interactive shell, yielding a pending mechanistic chunk. The curl lives in the sandbox entrypoint (no `sandbox connect`, no SSH).

**Run:**

```
SANDBOX=bridge-test
openshell sandbox delete "$SANDBOX" 2>/dev/null || true   # delete-if-exists (safe when absent)
openshell sandbox create --name "$SANDBOX" --no-auto-providers --no-tty --detach \
  -- bash -lc 'curl -sf --max-time 5 https://blocked.invalid/ || true'
sleep 15
```

**Pass when:**

```
openshell rule get "$SANDBOX" --status pending 2>&1 | grep -qi 'blocked.invalid' && echo PENDING_CHUNK_OK
```

`PENDING_CHUNK_OK` must print. The 15s wait exceeds the denial aggregator's ~10s flush. If there is no chunk, `rule get` prints "No network rules for sandbox" and the grep fails.

**On failure:** confirm the container runtime is running (Step 1) and `agent_policy_proposals_enabled` is true (Step 3). Wait another 15s and re-check (first sandbox image pull from ghcr.io can take minutes; the flush only starts after the sandbox is up and the CONNECT is attempted). `sandbox create` returns ALREADY_EXISTS if the name is taken, which the delete-first line prevents.

# Step 7 - Confirm the bridge posted the approval card

**Goal:** verify, without a human watching Slack, that the pending chunk became a Slack card.

**Run:**

```
sleep 6   # let one poll cycle (POLL_INTERVAL_MS=3000) discover and post
grep -F 'Posted approval request.' "$WORK/bridge.log" && echo CARD_POSTED
jq '.chunks[] | select(.messageTs != null) | {chunkId, channelId, messageTs}' state/bridge-state.json
```

**Pass when:** `CARD_POSTED` prints, and `state/bridge-state.json` shows a record with a `channelId` matching the approval channel and a non-null `messageTs`. That state record is the bridge's own proof the `chat.postMessage` landed (the bot token has only `chat:write`, so it cannot read the channel back).

**On failure:** if `Posted approval request.` never appears, grep for `not_in_channel` (the bot was not invited; a human must `/invite @openshell_admin`, then it reposts next poll). Confirm the pending chunk still exists (Step 6). Optional external read-back requires a separate read-scoped token and is not the bridge's capability.

# Step 8 - Decide, and verify policy hot-reload

**Goal:** exercise the decision and confirm the gateway hot-reloads.

**Real end-to-end test (needs a human):** a configured admin clicks Approve (with the confirm) or Reject (reason modal) on the card in Slack. The card rewrites in place to a terminal state naming who decided and the new policy version. This is the only path that proves the real button, the admin gate, the per-chunk lock, and the approved-terminal rewrite.

**Agent-only substitute (no human):** the agent can prove the gateway half and the bridge's out-of-band closure path by approving via the CLI. Note this deliberately BYPASSES the bridge decision path, so the bridge detects an out-of-band decision and rewrites the card to "Closed" (not "Approved") - which is itself correct, verifiable behavior.

```
CHUNK_ID="$(openshell rule get "$SANDBOX" --status pending 2>&1 \
  | sed -E $'s/\x1b\\[[0-9;]*m//g' \
  | awk '/^ *Chunk:/ {print $2; exit}')"
echo "chunk: $CHUNK_ID"
openshell rule approve "$SANDBOX" --chunk-id "$CHUNK_ID"
sleep 8
```

**Pass when (substitute path):**

```
openshell rule get "$SANDBOX" --status pending 2>&1 | grep -qi 'blocked.invalid' && echo STILL_PENDING || echo CLEARED_FROM_PENDING
grep -F 'Chunk closed out-of-band.' "$WORK/bridge.log" && echo BRIDGE_SAW_CLOSURE
```

`CLEARED_FROM_PENDING` confirms the gateway approved and hot-reloaded the policy; `BRIDGE_SAW_CLOSURE` confirms the bridge's poller detected the out-of-band decision and closed the card. (`rule reject "$SANDBOX" --chunk-id "$CHUNK_ID" --reason "..."` is the reject variant. `rule approve` auto-fetches the review token; you do not pass one.)

**On failure:** if `$CHUNK_ID` is empty, the chunk was already decided (perhaps a human clicked first). Re-run Step 6 to make a fresh one.

# Step 9 - Capture sink: stream an OCSF audit event into a private channel

**Goal:** prove the audit sink posts an OpenShell OCSF event into the private audit channel, verified without a human watching Slack. The audit sink is a SEPARATE, post-only process (`npm run start:capture`), independent of the approve/reject bridge: it shares only config loading, never touches the gRPC decision path, and does no dedup. This step uses the HTTP receiver source because its response body is a checkable assertion; the file-tail source is the production-native path (point `CAPTURE_SOURCES=file` + `CAPTURE_FILE_PATH` at OpenShell's OCSF JSONL log).

**Precheck:** you need an audit channel ID (`C0...`) that is DISTINCT from every approval channel, with the bot invited to it (`/invite @openshell_admin`). This is a Human input (see the table). The step is safe to re-run.

**Run (adds `routing.audit_channel`, starts the sink on loopback, then POSTs one synthetic OCSF event):**

```
cd slack-admin-bridge

# Add the audit channel to the YAML. Full rewrite, mirroring Step 4, so it is
# idempotent; audit_channel MUST differ from every approval channel.
cat > config/admins.yaml <<EOF
admins:
  - slack_user_id: "${ADMIN_USER_ID}"
    name: "Admin"
    role: "super_admin"
routing:
  default_channel: "${APPROVAL_CHANNEL_ID}"
  audit_channel: "${AUDIT_CHANNEL_ID}"
  workspace_channels:
    default: "${APPROVAL_CHANNEL_ID}"
settings:
  reject_reason_required: true
  destructive_roles: ["super_admin"]
EOF

# An ephemeral bearer the receiver requires; keep it out of any committed file.
CAPTURE_TOKEN="$(openssl rand -hex 16)"

# Start the audit sink as a background daemon (single-instance guard).
if [ -f "$WORK/capture.pid" ] && ps -p "$(cat "$WORK/capture.pid")" >/dev/null 2>&1; then
  kill "$(cat "$WORK/capture.pid")"; sleep 2
fi
nohup env $(grep -v '^#' .env | xargs) \
  CAPTURE_SOURCES=http \
  CAPTURE_RECEIVER_BIND=127.0.0.1:8090 \
  CAPTURE_RECEIVER_TOKEN="$CAPTURE_TOKEN" \
  node dist/capture-main.js > "$WORK/capture.log" 2>&1 &
echo $! > "$WORK/capture.pid"
sleep 4

# POST one synthetic OCSF event (NDJSON: one bare OCSF object) with the bearer.
NOW_MS=$(( $(date +%s) * 1000 ))
curl -sS -o "$WORK/capture-post.json" -w '%{http_code}' \
  -X POST http://127.0.0.1:8090/ \
  -H "Authorization: Bearer $CAPTURE_TOKEN" \
  -H 'Content-Type: application/x-ndjson' \
  --data-binary "{\"class_name\":\"HTTP Activity\",\"category_name\":\"Network Activity\",\"activity_name\":\"Connect\",\"severity\":\"Low\",\"time\":$NOW_MS,\"message\":\"egress connection to api.github.com:443\",\"actor\":{\"user\":{\"name\":\"carol@example.com\"}},\"metadata\":{\"product\":{\"name\":\"OpenShell\"}}}" \
  > "$WORK/capture-http-code.txt"
```

**Pass when:**

```
grep -F 'Audit sink started.' "$WORK/capture.log" && echo SINK_UP
grep -F 'Audit receiver listening.' "$WORK/capture.log" && echo RECEIVER_UP
test "$(cat "$WORK/capture-http-code.txt")" = "202" && echo POST_202
jq -e '.ok==true and .posted==1 and .dropped==0' "$WORK/capture-post.json" >/dev/null && echo POSTED_ONE
```

All four must print. `POSTED_ONE` (the receiver's own 202 tally) is the sink's proof it accepted and enqueued the event for `chat.postMessage`; as in Step 7, the bot has only `chat:write` and cannot read the channel back, so the response body - not a channel read - is the assertion. A human can confirm the card visually in the audit channel.

**On failure:** HTTP `401` = wrong or empty bearer (the receiver requires `Authorization: Bearer`). `curl` connection refused / code `000` = the receiver never bound; grep the log for `Audit receiver listening.` and check nothing else holds `:8090`. `.posted==0` with `.filtered==1` = the event matched `capture.exclude_event_types`; clear that filter. `.dropped==1` (HTTP `503`) = the bounded send queue was full (unexpected for a single event). If the log says `Capture is disabled` the `CAPTURE_SOURCES` env did not reach the process; if startup throws `must not equal any approval channel` the audit channel collides with an approval channel, and `requires routing.audit_channel` means the YAML line is missing. Fix and re-run.

# Step 10 - Report and clean up

**Goal:** produce evidence and leave the host clean.

**Capture:** the `GATEWAY_OK` / `MTLS_BUNDLE_OK` / `PROPOSALS_ON` / `SOCKET_OK` / `RECONCILE_OK` / `POLLER_OK` / `PENDING_CHUNK_OK` / `CARD_POSTED` / `CLEARED_FROM_PENDING` markers; the capture markers `SINK_UP` / `RECEIVER_UP` / `POST_202` / `POSTED_ONE`; the `state/bridge-state.json` record; and, if a human ran the real test, a screenshot of the card before and after the click. If anything broke, run `npm run support-bundle` and attach `support-bundle.jsonl` (share-safe: no tokens, IDs, hostnames, or message text).

**Clean up:**

```
kill "$(cat "$WORK/bridge.pid")" 2>/dev/null || true    # triggers "Shutting down."
kill "$(cat "$WORK/capture.pid")" 2>/dev/null || true   # triggers "Shutting down audit sink."
openshell sandbox delete "$SANDBOX" 2>/dev/null || true
```

> [!NOTE]
> Honest limits of headless execution: an agent can automate Steps 1-7 and 9, and the Step 8 substitute, in full. It CANNOT create the Slack app, mint the tokens, invite the bot, or click the real Approve/Reject button - those need a human once, and their outputs are the "Human inputs" above. The CLI-approve substitute proves gateway hot-reload and the bridge's closure detection, but not the real button, the admin gate, or the approved (vs closed) terminal rewrite.

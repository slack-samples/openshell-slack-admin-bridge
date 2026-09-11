# Deployment runbook

How to stand up the OpenShell Slack Admin Bridge against a real OpenShell gateway. For what the
bridge does and its design, see the [README](../README.md). For local testing with the in-memory
mock, see the README's "Local testing" section.

## Prerequisites

- Node.js 22+ and npm.
- Network reach from wherever the bridge runs to the OpenShell gateway (gRPC).
- A Slack workspace where you can install an app.
- OpenShell gateway credentials: an mTLS bundle (single-host installs) or a bearer token
  (Docker/Helm/K8s installs).

## 1. Create the Slack app

The app runs in Socket Mode, so it needs no public request URLs.

1. Go to [api.slack.com/apps](https://api.slack.com/apps) -> **Create New App** -> **From a manifest**.
2. Pick the target workspace and paste [`manifest.json`](../manifest.json).
3. Review and create.

The app deliberately requests a single bot scope, `chat:write`, so admins can approve the install
with minimal review. Two consequences to know:

- **The bot does not self-join channels.** Self-join would require `channels:join`; it is omitted to
  keep the scope surface small. You must create the approval channel and invite the bot yourself
  (next step). If the bot is later removed from the channel, posts fail with `not_in_channel` and the
  bridge retries on each poll until it is re-invited (no restart needed).
- **Messages tab off, Home tab on** (`features.app_home`). Approvals route to a channel, not DMs, so
  the app needs no Messages tab (`messages_tab_enabled: false`). The App Home dashboard uses the Home
  tab (`home_tab_enabled: true`) instead. Neither tab adds an OAuth scope.

### Tokens

1. **Bot token** (`xoxb-...`): install the app to the workspace, then copy from
   *OAuth & Permissions*.
2. **App-level token** (`xapp-...`): *Basic Information* -> *App-Level Tokens* -> generate one with
   the `connections:write` scope. Required for Socket Mode.

Keep both out of the repo. They go in `.env` only (see below).

### Create the channel and invite the bot

The bot cannot add itself, so this step is required:

1. Create (or pick) the channel where approval cards should land. A private channel is fine.
2. Invite the bot: `/invite @openshell_admin`.
3. Copy the channel's ID (Slack: channel name -> *View channel details* -> bottom of the About tab).
   It goes in `config/admins.yaml` as `routing.default_channel`.

If the bot is later removed from the channel, posts fail with `not_in_channel`; re-invite it and the
next poll re-posts any pending cards.

## 2. Configure

```bash
cp .env.example .env
cp config/admins.example.yaml config/admins.yaml
```

`.env` holds Slack tokens and the OpenShell endpoint/auth. `config/admins.yaml` holds the admin
allow-list and channel routing. **Neither is committed** (both are gitignored).

### Admins and routing (`config/admins.yaml`)

```yaml
admins:
  - slack_user_id: "U0XXXXXXXXX"   # only these users can approve/reject
    name: "Jane Admin"
    role: "super_admin"            # super_admin | admin
routing:
  default_channel: "C0XXXXXXXXX"   # approval cards land here
  workspace_channels:              # optional per-OpenShell-workspace overrides
    default: "C0XXXXXXXXX"
settings:
  reject_reason_required: true
  destructive_roles: ["super_admin"]  # gate for batch/destructive actions
```

Only Slack user IDs in `admins` can act on a card. Everyone else who clicks a button gets an
ephemeral "not an authorized admin" reply and nothing is written to OpenShell.

### Connecting to OpenShell (`.env`)

- **mTLS (single-host default):**

  ```
  OPENSHELL_GATEWAY_URL=<gateway-host>:17670
  OPENSHELL_AUTH_MODE=mtls
  OPENSHELL_USE_TLS=true
  OPENSHELL_CA_CERT=${HOME}/.config/openshell/gateways/openshell/mtls/ca.crt
  OPENSHELL_CLIENT_CERT=${HOME}/.config/openshell/gateways/openshell/mtls/tls.crt
  OPENSHELL_CLIENT_KEY=${HOME}/.config/openshell/gateways/openshell/mtls/tls.key
  OPENSHELL_SERVER_NAME=<cert-CN-if-it-differs-from-dial-host>
  ```

- **Bearer (Docker/Helm/K8s):**

  ```
  OPENSHELL_GATEWAY_URL=<gateway-host>:8080
  OPENSHELL_AUTH_MODE=bearer
  OPENSHELL_USE_TLS=true
  OPENSHELL_BEARER_TOKEN_FILE=/path/to/token   # or OPENSHELL_BEARER_TOKEN inline
  ```

`OPENSHELL_USE_TLS=false` is for the local mock only. Never disable TLS against a real gateway.

## 3. Run

```bash
npm install
npm run build
npm start          # runs dist/index.js
# or, for iteration:
npm run dev        # tsx watch against the configured gateway
```

On start the bridge:

1. Connects to Slack over Socket Mode and to OpenShell over gRPC.
2. Runs startup reconciliation: reposts any pending chunk that never got a Slack message.
3. Begins polling `GetDraftPolicy` every `POLL_INTERVAL_MS` (default 3000ms). OpenShell has no
   push for new proposals, so polling is mandatory.

## 4. Verify the loop

1. Trigger a denied egress from a sandboxed agent (or approve/reject a pre-existing pending chunk).
2. Confirm an approval card appears in the routed channel.
3. As a configured admin, click **Approve** (with the confirm) or **Reject** (reason modal).
4. Confirm the card rewrites to a terminal state noting who decided and the new policy version, and
   that OpenShell shows the chunk approved/rejected and the policy hot-reloaded.

## Operational notes

- **State file** (`STATE_STORE_PATH`, default `./state/bridge-state.json`): the bridge owns approver
  identity and message coordinates keyed by `chunk_id`. Back it up if you need decision provenance
  to survive host loss; it is rebuilt for pending chunks on restart but terminal history is local.
- **Single in-flight decision:** a per-chunk lock prevents two admins from double-deciding.
- **Stale `review_token`:** refreshed once automatically on `FAILED_PRECONDITION`, then retried.
- **Out-of-band decisions:** a chunk decided outside Slack is detected on the next poll and its card
  is closed.
- **Logs** go to stdout (pino JSON). Set `LOG_LEVEL=debug` for verbose Bolt/gateway tracing. These
  operational logs are for you: they can carry channel/user IDs and hostnames, so treat them like any
  other infra log.
- **Diagnostics** are a separate, share-safe stream written to `./state/diagnostics.jsonl`
  (override with `DIAGNOSTICS_PATH`). See "Reporting a bug" below. It appends only when something
  goes wrong (plus one startup fingerprint line), so it stays small.

## Reporting a bug

The bridge keeps a second, deliberately minimal log designed to be safe to hand to Slack when you
hit a problem. It is an allow-list, not a redaction pass: only a fixed set of non-identifying fields
are ever written, so nothing sensitive can slip in even from an unexpected error.

A diagnostics entry contains only:

- an error code (e.g. `POST_FAILED`, `STALE_REVIEW_TOKEN`) and a random per-run session id,
- the gRPC/Slack status slug for the failure (e.g. `UNAVAILABLE`, `not_in_channel`) and an HTTP
  status number,
- the top few stack frames, reduced to `src/`-relative `file:line` (no absolute paths),
- small counts and enums (retry number, admin count, poll interval, auth mode, TLS on/off),
- a version fingerprint (app version, Node version, OS platform/arch).

It never contains tokens, channel or user IDs, admin names, egress hostnames, file paths, request or
response bodies, or any message text. Chunk ids appear only as a salted per-run hash (`chunkRef`),
enough to correlate events within one run but not reversible to the original id.

To produce a bundle to attach to a support request:

```bash
npm run support-bundle
```

This reads the diagnostics file, re-verifies every line against the same share-safety allow-list as
a final gate, and writes `./support-bundle.jsonl` (override with `SUPPORT_BUNDLE_PATH`). If any line
would fail the check it refuses to write and prints what it caught, so the export can only ever emit
vetted content. Both `diagnostics*.jsonl` and `support-bundle*.jsonl` are gitignored. You are welcome
to open the file and read it before sending; it is plain JSON lines.

## Security

- Tokens and the admin/routing config live only in `.env` and `config/admins.yaml`, both gitignored.
  Nothing sensitive is committed.
- Minimal OAuth surface: the app requests only `chat:write`. It reads no channel, user, or message
  history and cannot join channels on its own, so the install is easy for admins to approve.
- Approve/reject is gated server-side on the Slack-verified clicker identity against the admin
  allow-list; buttons are visible to the channel but only admins can action them.
- Scope is network egress only. Filesystem and process policy are fixed at sandbox creation and are
  not proposable.

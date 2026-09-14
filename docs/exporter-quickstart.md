# Quick start: local OpenShell gateway + exporter + Slack

Deploy all three components and verify with a ** sandbox network denial**.
No synthetic JSONL or sample approval injection is used.

```text
Slack bridge (Mac) ──mTLS──> local OpenShell gateway (Mac service)
                                   │ manages Docker sandbox
Exporter (Docker) ──mTLS WatchSandbox┘
       ↑ reads shared OCSF volume written by sandbox supervisor
       └──HTTPS CloudEvents──> Slack capture (Mac) ──> Slack
```

This recipe uses the standard local mTLS gateway, not the custom plaintext
gateway on port 8180 in the earlier demo. Use a **fresh local setup**; do not
reinstall an existing gateway or start duplicate processes on its ports/state.
The existing demo does not need redeployment to use this guide.

## 1. Deploy the local gateway

Requirements: macOS Apple Silicon, Homebrew, Docker Desktop, Node.js 22+,
Git and OpenSSL with `req -addext` support. Enable Docker Desktop **Settings →
Resources → Network → Enable host networking** (4.34+). This lets the exporter
use the gateway's `localhost` TLS identity without skipping verification.
Host networking is incompatible with Enhanced Container Isolation; do not
disable an organizational security control to follow this recipe.
[Docker networking requirements](https://docs.docker.com/engine/network/drivers/host/).

On a fresh setup, install the CLI **and local gateway service**:

```bash
curl -fsSL https://raw.githubusercontent.com/NVIDIA/OpenShell/v0.0.113/install.sh \
  -o /tmp/openshell-install-v0.0.113.sh
# Inspect the installer before running it.
OPENSHELL_VERSION=v0.0.113 sh /tmp/openshell-install-v0.0.113.sh
openshell gateway info --name openshell
openshell status --gateway openshell
```

The macOS installer starts the Homebrew service and registers gateway
`openshell` at `https://localhost:17670`. Confirm it is connected and uses the
Docker compute driver. Its client mTLS bundle is at
`$HOME/.config/openshell/gateways/openshell/mtls/{ca.crt,tls.crt,tls.key}`.
Keep the private key secret; do not disable gateway TLS/authentication.

## 2. Deploy Slack code and connect it to the gateway

Clone the fork's integration branch containing the exporter **envelope-v1 adapter**
(`src/capture/cloudevents.ts`). These changes are not yet merged upstream;
a stock upstream clone is not the tested working tree.

```bash
git clone --branch codex/local-exporter-integration https://github.com/delgadof/openshell-slack-admin-bridge.git
cd openshell-slack-admin-bridge
```

From its repository root, follow [Slack app setup](03-deployment.md#1-create-the-slack-app)
and create `.env`/`config/admins.yaml` if absent. Preserve existing files.

Put Slack bot/app tokens in `.env`, then configure the ** local gateway**:

```dotenv
OPENSHELL_GATEWAY_URL=localhost:17670
OPENSHELL_AUTH_MODE=mtls
OPENSHELL_USE_TLS=true
OPENSHELL_SERVER_NAME=localhost
OPENSHELL_CA_CERT=${HOME}/.config/openshell/gateways/openshell/mtls/ca.crt
OPENSHELL_CLIENT_CERT=${HOME}/.config/openshell/gateways/openshell/mtls/tls.crt
OPENSHELL_CLIENT_KEY=${HOME}/.config/openshell/gateways/openshell/mtls/tls.key
OPENSHELL_WORKSPACE=default
```

Add your Slack user ID to `admins`. Set `routing.default_channel` to the approval
channel and `routing.audit_channel` to a **different** audit channel. Invite the
bot to both. The app's Home tab displays the audit summary.

## 3. Configure and start Slack capture

Run once from the Slack repository root; never regenerate over an existing
installation. `state/` is gitignored and must not be published.

```bash
umask 077
mkdir -p state/exporter/{state,output,secrets}
openssl rand -hex 32 -out state/exporter/secrets/capture-token
openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
  -keyout state/exporter/secrets/capture.key -out state/exporter/secrets/capture.crt \
  -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
```

Add to `.env`:

```dotenv
CAPTURE_SOURCES=http
CAPTURE_RECEIVER_BIND=127.0.0.1:8090
CAPTURE_RECEIVER_TOKEN_FILE=./state/exporter/secrets/capture-token
CAPTURE_RECEIVER_TLS_CERT=./state/exporter/secrets/capture.crt
CAPTURE_RECEIVER_TLS_KEY=./state/exporter/secrets/capture.key
CAPTURE_SUMMARY_STATE=./state/audit-summary.json
```

Run `npm ci && npm run build`. Start `npm start` (bridge) in one terminal and
`npm run start:capture` in another, both at the Slack repository root.
The capture bearer token is separate from Slack tokens and the gateway mTLS key.

## 4. Connect a  sandbox's OCSF output

These settings affect the selected gateway globally: use the dedicated local
demo gateway, not a shared organizational gateway. They enable audit emission
and proposals, not automatic approval.

```bash
openshell settings set --gateway openshell --global --yes --key ocsf_json_enabled --value true
openshell settings set --gateway openshell --global --yes --key agent_policy_proposals_enabled --value true
docker volume create slack-live-ocsf
openshell sandbox create --gateway openshell --name slack-live-demo \
  --from ghcr.io/nvidia/openshell-community/sandboxes/base:latest@sha256:aeef1c63f00e2913ea002ccb3aaf925f338b5c5d70e63576f0d95c16a138044e \
  --policy examples/slack-deny-egress.yaml \
  --driver-config-json '{"docker":{"mounts":[{"type":"volume","source":"slack-live-ocsf","target":"/var/log","read_only":false}]}}' \
  --no-auto-providers --no-tty --detach -- bash -lc 'while true; do sleep 3600; done'
```

The supervisor writes  `openshell-ocsf.*.log` files into `slack-live-ocsf`.
The exporter mounts that **same volume read-only** at `/var/log/openshell`.
No manual file copying or guessed host directory is needed. If the sandbox
already exists, preserve it and choose a new name; update
`watchsandbox.sandbox_names` in the config to match.

## 5. Build and deploy the exporter

From the Slack repository root, use a fresh sibling Research checkout; preserve
an existing checkout. This pins the merged [PR70](https://github.com/NVIDIA/OpenShell-Research/pull/70)
source, not an assumed published container image.

```bash
git clone https://github.com/NVIDIA/OpenShell-Research.git ../OpenShell-Research
git -C ../OpenShell-Research checkout --detach 26dbfd52730429695670c27a0ec0449a851e755c
docker build --platform linux/amd64 \
  --build-arg VERSION=0.0.5-rc.1 \
  --build-arg VCS_REF=26dbfd52730429695670c27a0ec0449a851e755c \
  -t openshell-exporter:slack-26dbfd5 ../OpenShell-Research/projects/openshell-exporter

docker run --detach --name openshell-exporter-slack --platform linux/amd64 \
  --network host --user "$(id -u):$(id -g)" --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --workdir /work \
  -v "$PWD/examples/exporter-to-slack.yaml:/work/config.yaml:ro" \
  -v slack-live-ocsf:/var/log/openshell:ro \
  -v "$HOME/.config/openshell/gateways/openshell/mtls:/run/secrets/gateway:ro" \
  -v "$PWD/state/exporter/secrets/capture-token:/work/secrets/capture-token:ro" \
  -v "$PWD/state/exporter/secrets/capture.crt:/work/secrets/capture.crt:ro" \
  -v "$PWD/state/exporter/state:/work/state" \
  -v "$PWD/state/exporter/output:/work/output" \
  openshell-exporter:slack-26dbfd5 --config /work/config.yaml
```

The supplied [exporter config](../examples/exporter-to-slack.yaml) already wires:

- Gateway API: `https://localhost:17670`, mTLS, workspace `default`, sandbox `slack-live-demo`.
- Native OCSF: `/var/log/openshell/openshell-ocsf.*.log` from the shared volume.
- Normalization/redaction, persistent checkpoints, retry queue and recovery output.
- Slack capture: `https://localhost:8090/v1/events`, trusted certificate and shared bearer.

`gateway_id: openshell` is this deployment's correlation label, not an auth
credential. The fresh volume is read from its beginning to include startup
events; saved offsets resume after restart. Do not clear state to replay history.

## 6. Verify with a  denied operation

```bash
curl --fail http://127.0.0.1:13133/
docker logs --tail 30 openshell-exporter-slack
openshell sandbox connect --gateway openshell slack-live-demo
```

Inside the sandbox:

```bash
curl --max-time 10 https://example.org
exit
```

The deny-all network policy should produce proxy **HTTP 403**. Verify separately:

1. A new denial appears in `state/exporter/output/events.json`.
2. The audit card reaches Slack and App Home activity updates.
3. The gateway's generated proposal appears in the approval channel. A denial
   and proposal are distinct records; confirm both rather than assuming.
4. As an authorized admin, optionally approve/reject that specific proposal.
   Reconnect and retry the **same** request to verify the effective policy.

Do not use `seed-approvals.sh` for this verification. No fake JSONL is needed.
Health alone is not end-to-end proof. `WatchSandbox` adds gateway logs/status
and policy context; the shared volume supplies native OCSF records.

Keep state/output and one writer per checkpoint directory. Slack is rate-limited;
its queue is in-memory and retries can duplicate cards. Keep durable recovery
output as the audit record. OpenShell 0.0.113 may need recovery after sandbox-token
expiry/long host sleep; this is not a production HA recipe.

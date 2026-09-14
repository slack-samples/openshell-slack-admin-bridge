# Quick start: local OpenShell gateway + exporter + Slack

Run each component explicitly, then verify with a real sandbox network denial.
There is no launcher, Compose stack, synthetic JSONL, or sample approval injection.

```text
Slack bridge (Mac) ──mTLS──> OpenShell gateway (Mac) ──> Docker sandbox
                                  ↑                       │ OCSF JSONL
                            mTLS WatchSandbox             ↓
Slack capture (Mac) <──HTTPS── Exporter (Docker) <── shared log volume
       │
       └── Slack audit cards / App Home
```

The bridge handles approvals directly with the gateway. The exporter collects
audit data and sends it to capture. Capture formats it for Slack.

This walkthrough targets **macOS Apple Silicon with Docker Desktop** and the
standard local mTLS gateway. It uses ordinary Docker **bridge networking**:
containers reach Mac services through `host.docker.internal`. **Do not enable
Docker Desktop host networking or restart Docker for this guide.**
[Docker's container-to-host networking documentation](https://docs.docker.com/desktop/features/networking/networking-how-tos/).

Use a dedicated demo gateway. For an existing deployment, reuse its configuration
deliberately; do not overwrite secrets or start duplicate services. Stop at any
failed check rather than continuing to later commands.

## 1. Choose directories and get the Slack code

Requirements: Homebrew, Docker Desktop running, Git, Node.js 22+, and OpenSSL
with `req -addext` support. Shell examples use Bash/zsh. Change these **absolute
paths** as needed. Repeat this variable block in each new terminal. Existing
checkouts can be anywhere, including paths with spaces: set `SLACK_DIR` and
`EXPORTER_SRC` to those locations instead of cloning again.

```bash
export QUICKSTART_ROOT="$HOME/openshell-slack-demo"
export SLACK_DIR="$QUICKSTART_ROOT/openshell-slack-admin-bridge"
export EXPORTER_SRC="$QUICKSTART_ROOT/OpenShell-Research"
export DEMO_STATE="$SLACK_DIR/state/exporter"
export GATEWAY="openshell"
export DEMO_WORKSPACE="default"
export SANDBOX_NAME="slack-live-demo"
export OCSF_VOLUME="slack-live-ocsf"
export GATEWAY_MTLS="$HOME/.config/openshell/gateways/$GATEWAY/mtls"
export EXPORTER_IMAGE="openshell-exporter:slack-latest"
mkdir -p "$QUICKSTART_ROOT"
```

For a new checkout, the intended upstream location is:

```bash
git clone https://github.com/slack-samples/openshell-slack-admin-bridge.git "$SLACK_DIR"
```

If it already exists, skip cloning and review its branch/changes before updating.
This guide requires the envelope-v1 adapter in this change set. **Until that
change is merged upstream, use the reviewed contribution branch**; do not assume
upstream `main` already contains it. Check the checkout:

```bash
git -C "$SLACK_DIR" status --short --branch
test -f "$SLACK_DIR/examples/exporter-to-slack.yaml"
grep -q 'urn:openshell:event-envelope:1' "$SLACK_DIR/src/capture/cloudevents.ts"
docker info >/dev/null
node --version
```

The walkthrough is intended for upstream `main` once reviewed and merged; no
personal fork or older demo directory is required by the deployment itself.

## 2. Install or connect to the local gateway

For an **existing** gateway, skip installation. On a **fresh** Mac, inspect the
pinned installer first; it installs the CLI and local gateway service. This
recipe is pinned to OpenShell **0.0.113**.

```bash
curl -fsSL https://raw.githubusercontent.com/NVIDIA/OpenShell/v0.0.113/install.sh \
  -o "$QUICKSTART_ROOT/openshell-install-v0.0.113.sh"
# Read the installer first; run only on a fresh setup.
OPENSHELL_VERSION=v0.0.113 sh "$QUICKSTART_ROOT/openshell-install-v0.0.113.sh"
```

Select Homebrew's binary explicitly to avoid an older pip/uv CLI on PATH. For
another installation, use its absolute binary path. Repeat this assignment in
each terminal using the CLI.

```bash
export OPENSHELL_BIN="$(brew --prefix openshell)/bin/openshell"
"$OPENSHELL_BIN" --version
"$OPENSHELL_BIN" sandbox create --help | grep -- --driver-config-json
"$OPENSHELL_BIN" gateway info --gateway "$GATEWAY"
"$OPENSHELL_BIN" provider list-profiles --gateway "$GATEWAY"
```

Confirm a healthy gateway with the Docker compute driver at
`https://localhost:17670`. Resolve any invalid provider profiles before proceeding;
do not bypass credential inspection to fix catalog validation.

The client bundle contains `ca.crt`, `tls.crt`, and `tls.key` under `GATEWAY_MTLS`.
Keep the key private. The gateway **server** certificate must cover
`host.docker.internal`; the standard installer bundle does. A custom gateway
needs a reachable hostname covered by its certificate. Do not skip TLS validation.

## 3. Configure and start the Slack bridge and capture receiver

Follow [Slack app setup](03-deployment.md#1-create-the-slack-app): create/install
the Socket Mode app and obtain bot and app-level tokens. From the checkout:

```bash
cd "$SLACK_DIR"
test -e .env || cp .env.example .env
test -e config/admins.yaml || cp config/admins.example.yaml config/admins.yaml
chmod 600 .env config/admins.yaml
```

Edit `.env` locally to set Slack tokens and the following gateway settings.
If you changed the gateway/workspace or bundle location, use matching values and
absolute paths here. The app expands `${HOME}` but not arbitrary shell variables
inside `.env`.

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

In `config/admins.yaml`, add your Slack user ID to `admins`, set
`routing.default_channel` to the approval channel and `routing.audit_channel`
to a different audit channel. Invite the bot to both.

For a **new capture receiver**, create a private bearer token and self-signed TLS
certificate once. The guard refuses to overwrite existing files or directories.

```bash
umask 077
mkdir -p "$DEMO_STATE"/state "$DEMO_STATE"/output "$DEMO_STATE"/secrets
if [ ! -e "$DEMO_STATE/secrets/capture-token" ] && \
   [ ! -e "$DEMO_STATE/secrets/capture.key" ] && \
   [ ! -e "$DEMO_STATE/secrets/capture.crt" ]; then
  openssl rand -hex -out "$DEMO_STATE/secrets/capture-token" 32 &&
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
    -keyout "$DEMO_STATE/secrets/capture.key" \
    -out "$DEMO_STATE/secrets/capture.crt" \
    -subj '/CN=host.docker.internal' \
    -addext 'subjectAltName=DNS:host.docker.internal,DNS:localhost,IP:127.0.0.1'
else
  echo "Capture material already exists: inspect and reuse it; do not overwrite it."
fi
```

Add to `.env`. Relative paths resolve from `SLACK_DIR`, where both Node processes
run. If you chose another `DEMO_STATE`, put its absolute paths here instead.

```dotenv
CAPTURE_SOURCES=http
CAPTURE_RECEIVER_BIND=127.0.0.1:8090
CAPTURE_RECEIVER_TOKEN_FILE=./state/exporter/secrets/capture-token
CAPTURE_RECEIVER_TLS_CERT=./state/exporter/secrets/capture.crt
CAPTURE_RECEIVER_TLS_KEY=./state/exporter/secrets/capture.key
CAPTURE_SUMMARY_STATE=./state/audit-summary.json
```

For an **existing receiver**, reuse its exact bearer token and trusted CA rather
than generating unrelated credentials. Put copies at the exporter's token/CA
paths above, or change the source mounts in step 6. With a CA-signed receiver
certificate, the exporter needs the **CA certificate**, not the server private
key. Never mount the capture private key into the exporter. Do not start another
receiver on port 8090 or another bridge using the same state.

Build once, then run the processes in separate terminals:

```bash
cd "$SLACK_DIR"
npm ci && npm run build
npm start
```

```bash
# Repeat step 1's variable block in this terminal first.
cd "$SLACK_DIR"
npm run start:capture
```

Keep these running and use another terminal for the next steps. Capture remains
bound to Mac loopback; Docker Desktop provides the container-to-host connection.
Do not expose it to the LAN as a shortcut.

## 4. Create a real sandbox and expose its OCSF volume

These settings affect the selected gateway globally: use a dedicated demo
gateway. They enable emission and proposals, not automatic approval. Check for
an existing sandbox name before creating:

```bash
"$OPENSHELL_BIN" sandbox list --gateway "$GATEWAY" --workspace "$DEMO_WORKSPACE"
"$OPENSHELL_BIN" settings set --gateway "$GATEWAY" --global --yes --key ocsf_json_enabled --value true
"$OPENSHELL_BIN" settings set --gateway "$GATEWAY" --global --yes --key agent_policy_proposals_enabled --value true
docker volume create "$OCSF_VOLUME"
"$OPENSHELL_BIN" sandbox create --gateway "$GATEWAY" --workspace "$DEMO_WORKSPACE" \
  --name "$SANDBOX_NAME" \
  --from ghcr.io/nvidia/openshell-community/sandboxes/base:latest@sha256:aeef1c63f00e2913ea002ccb3aaf925f338b5c5d70e63576f0d95c16a138044e \
  --policy "$SLACK_DIR/examples/slack-deny-egress.yaml" \
  --driver-config-json "{\"docker\":{\"mounts\":[{\"type\":\"volume\",\"source\":\"$OCSF_VOLUME\",\"target\":\"/var/log\",\"read_only\":false}]}}" \
  --no-auto-providers --no-tty --detach -- bash -lc 'while true; do sleep 3600; done'
"$OPENSHELL_BIN" sandbox get "$SANDBOX_NAME" --gateway "$GATEWAY" --workspace "$DEMO_WORKSPACE"
```

Wait for **Ready**. If a sandbox already exists, inspect/reuse it or select a new
name (maximum 19 characters in this CLI); do not delete it blindly. Reused
sandboxes must actually have the log mount. The supervisor writes
`openshell-ocsf.*.log` into this volume. The exporter mounts the same volume
read-only at `/var/log/openshell`; no guessed host log paths or manual copying.

## 5. Get the latest exporter source and build the image

The exporter lives in [NVIDIA/OpenShell-Research](https://github.com/NVIDIA/OpenShell-Research/tree/main/projects/openshell-exporter).
Use the latest merged code on that repository's `main` branch, with
`projects/openshell-exporter/` as the build context. There is no fixed exporter
commit or release version in this guide.
No pull-request branch or NVIDIA-published exporter image is required.

For a **new** checkout:

```bash
git clone --branch main --single-branch https://github.com/NVIDIA/OpenShell-Research.git "$EXPORTER_SRC"
```

For an **existing** checkout, inspect its remote, branch, and local changes first:

```bash
git -C "$EXPORTER_SRC" remote -v
git -C "$EXPORTER_SRC" status --short --branch
```

Only update a clean checkout on `main` whose `origin` is
`https://github.com/NVIDIA/OpenShell-Research.git` (or its SSH equivalent):

```bash
if [ -z "$(git -C "$EXPORTER_SRC" status --porcelain)" ] && \
   [ "$(git -C "$EXPORTER_SRC" branch --show-current)" = main ]; then
  git -C "$EXPORTER_SRC" pull --ff-only origin main
else
  echo "STOP: preserve this checkout; use a new EXPORTER_SRC directory and clone main there."
fi
```

If updating fails or the checkout has local commits, use a new directory and
clone `main` there; do not reset or discard local work. After a successful clone
or update, build the image:

```bash
export EXPORTER_REF="$(git -C "$EXPORTER_SRC" rev-parse HEAD)"
docker build --platform linux/amd64 \
  --build-arg VERSION=main \
  --build-arg VCS_REF="$EXPORTER_REF" \
  -t "$EXPORTER_IMAGE" "$EXPORTER_SRC/projects/openshell-exporter"
```

`EXPORTER_REF` records the revision actually built for traceability; it does not
select an old revision. `VERSION=main` is image metadata, not a release pin.
The local `slack-latest` tag does not update itself: pull and rebuild whenever
you want newer exporter code. An already-running container keeps its old image
until explicitly replaced; preserve its configuration, secrets, and state mounts
when doing so. Repeat the real-event verification after each update.
Docker Desktop uses emulation for this `linux/amd64` build on Apple Silicon.

## 6. Run the exporter on ordinary Docker networking

Copy the example to local state once so deployment edits never alter the shared
example. Environment variables below select the sandbox and gateway context.

```bash
test -e "$DEMO_STATE/config.yaml" || cp "$SLACK_DIR/examples/exporter-to-slack.yaml" "$DEMO_STATE/config.yaml"
export EXPORTER_GATEWAY_ENDPOINT="https://host.docker.internal:17670"
export EXPORTER_CAPTURE_ENDPOINT="https://host.docker.internal:8090/v1/events"
```

For another gateway/receiver, use reachable HTTPS endpoints covered by their
certificates and matching CA/client mounts. On native Linux,
`host.docker.internal` requires explicit host-gateway mapping and host services
reachable on that interface; Docker Desktop's loopback-forwarding recipe is not
a universal Linux configuration. Do not bypass TLS or host firewalls.

Inspect existing containers/ports and check every source file first. If a name
or health port is occupied, inspect that deployment; independent installations
need distinct names, ports, and state. Never run two exporters against the same
checkpoint/queue directory.

```bash
docker ps -a --filter name=openshell-exporter-slack
if lsof -nP -iTCP:13133 -sTCP:LISTEN; then
  echo "STOP: health port 13133 is already in use; inspect before proceeding."
fi
for required_file in "$DEMO_STATE/config.yaml" \
  "$DEMO_STATE/secrets/capture-token" "$DEMO_STATE/secrets/capture.crt" \
  "$GATEWAY_MTLS/ca.crt" "$GATEWAY_MTLS/tls.crt" "$GATEWAY_MTLS/tls.key"; do
  if [ ! -f "$required_file" ] || [ ! -s "$required_file" ]; then
    echo "STOP: missing, empty, or not a regular file: $required_file"
  fi
done
openssl x509 -in "$DEMO_STATE/secrets/capture.crt" -noout -dates
docker image inspect "$EXPORTER_IMAGE" --format '{{.Id}}'
```

Resolve every `STOP` before continuing. `--mount` fails when a source is missing;
unlike `-v`, it does not create empty directories in place of secret files.

```bash
docker run --detach --name openshell-exporter-slack --platform linux/amd64 \
  --network bridge --publish 127.0.0.1:13133:13133 \
  --user "$(id -u):$(id -g)" --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --workdir /work \
  --env EXPORTER_GATEWAY_ENDPOINT --env EXPORTER_CAPTURE_ENDPOINT \
  --env "OPENSHELL_GATEWAY_ID=$GATEWAY" --env "OPENSHELL_WORKSPACE=$DEMO_WORKSPACE" \
  --env "OPENSHELL_SANDBOX_NAME=$SANDBOX_NAME" \
  --env "EXPORTER_CLOUDEVENTS_SOURCE=openshell://$GATEWAY/$DEMO_WORKSPACE" \
  --mount "type=bind,source=$DEMO_STATE/config.yaml,target=/work/config.yaml,readonly" \
  --mount "type=volume,source=$OCSF_VOLUME,target=/var/log/openshell,readonly" \
  --mount "type=bind,source=$GATEWAY_MTLS,target=/run/secrets/gateway,readonly" \
  --mount "type=bind,source=$DEMO_STATE/secrets/capture-token,target=/work/secrets/capture-token,readonly" \
  --mount "type=bind,source=$DEMO_STATE/secrets/capture.crt,target=/work/secrets/capture.crt,readonly" \
  --mount "type=bind,source=$DEMO_STATE/state,target=/work/state" \
  --mount "type=bind,source=$DEMO_STATE/output,target=/work/output" \
  "$EXPORTER_IMAGE" --config /work/config.yaml
```

The container health listener binds `0.0.0.0:13133`, but its published Mac port
binds only `127.0.0.1`. There is no `--network host`. Native OCSF and authorized
WatchSandbox data pass through normalization/redaction and authenticated HTTPS
to capture. `gateway_id` is a correlation label, not an authorization credential.

## 7. Verify a real denied operation

```bash
curl --fail --max-time 5 http://127.0.0.1:13133/
docker logs --since 2m --tail 40 openshell-exporter-slack
"$OPENSHELL_BIN" sandbox connect --gateway "$GATEWAY" --workspace "$DEMO_WORKSPACE" "$SANDBOX_NAME"
```

Inside the sandbox:

```bash
curl --max-time 10 https://example.org
exit
```

The deny-all policy should return proxy **HTTP 403**. Verify each layer separately:

1. Sandbox remains Ready and the request is denied.
2. A matching record appears in `$DEMO_STATE/output/events.json`.
3. The audit card reaches Slack and App Home activity updates.
4. If the gateway produces a policy proposal, it appears in the approval channel.
   Denials and proposals are distinct; not every denied `curl` necessarily creates
   an approval request. The bridge must target this same gateway/workspace.
5. As an authorized admin, optionally approve/reject a specific proposal. Retry
   the same request to verify policy enforcement, not just a Slack button.

Health/"Everything is ready" only proves startup. Connection-refused, TLS, bearer,
or discovery errors mean a downstream connection still needs attention.

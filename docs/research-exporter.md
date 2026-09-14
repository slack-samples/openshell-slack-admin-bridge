# NVIDIA Research exporter integration

The audit receiver supports the experimental [OpenShell Event Exporter](https://github.com/NVIDIA/OpenShell-Research/pull/70)
under `projects/openshell-exporter/`. PR70 merged into `main` at
`26dbfd52730429695670c27a0ec0449a851e755c`. Its exporter tree is identical to the
tested/deployed PR-head build `b5be45f3f6838e8d44524d58a3136a510a74d482`.
The exporter runs separately; the bridge does not vendor or execute its Go code.

Path: OpenShell OCSF / authorized WatchSandbox sources → exporter → authenticated
HTTPS CloudEvents batch → capture receiver → Slack audit cards and App Home.
Approvals still use the bridge's direct gateway connection, not the exporter.

## Build the merged source

Clone Research into a separate directory and check out the exact merge
commit above. Build with `projects/openshell-exporter/` as the Docker context,
not the Research repository root. No NVIDIA-published exporter image is assumed.

```sh
git clone https://github.com/NVIDIA/OpenShell-Research.git
git -C OpenShell-Research checkout --detach 26dbfd52730429695670c27a0ec0449a851e755c
docker build --platform linux/amd64 \
  --build-arg VERSION=0.0.5-rc.1 \
  --build-arg VCS_REF=26dbfd52730429695670c27a0ec0449a851e755c \
  -t openshell-slack-demo-exporter:research-26dbfd5 \
  OpenShell-Research/projects/openshell-exporter
```

## Receiver and wire contract

Configure `CAPTURE_SOURCES=http`, `CAPTURE_RECEIVER_TOKEN_FILE`,
`CAPTURE_RECEIVER_TLS_CERT`, and `CAPTURE_RECEIVER_TLS_KEY`; see `.env.example`.
The exporter destination must use HTTPS, trust the receiver's CA, and send the
same bearer credential. Keep credentials out of source control and sandboxes.

Use exporter type `cloudevents` and `application/cloudevents-batch+json`.
For `dataschema: urn:openshell:event-envelope:1`, capture unwraps `data.original`,
preserves OCSF values, and fills missing sandbox/time/log-level display context.
Bare OCSF and other existing CloudEvents inputs remain supported.

Keep the exporter's retry queue and file checkpoints persistent. A full capture
queue returns HTTP 503 with Retry-After. Delivery is not exactly-once: partially
accepted batches may produce duplicates on retry. Slack's in-memory queue is
not an audit archive; retain a separate durable destination. Raw telemetry can
outpace Slack posting; use summary-only mode or deliberate filters as appropriate.

## Verify without posting to Slack

Run `npm test`, `npm run typecheck`, and `npm run build`. Receiver tests include
an upstream synthetic fixture and verify batch backpressure.
For actual-image verification on Docker Desktop:

```sh
node --import tsx scripts/verify-research-exporter.ts /absolute/path/to/demo/runtime/tls openshell-slack-demo-exporter:research-26dbfd5
```

The TLS directory must contain `ca.crt`, `slack-capture.crt`, and
`slack-capture.key`; the certificate must cover `host.docker.internal`.
The command creates an isolated receiver and temporary container, feeds one
synthetic event, verifies rendering, and removes its temporary resources. It
does not use Slack tokens, mount live exporter state, or call the Slack API.

## Experimental limitations

PR 70 includes delivery/privacy fixes and regressions for original-log-attribute
redaction and discovery cleanup. Our demo retains the normalized `openshell`
pipeline; it does not adopt `http.config.yaml`, which intentionally bypasses
normalization/redaction. Synthetic validation does not qualify sensitive data,
production capacity, every source lane, or ARM64 runtime operation. For future updates, intentionally update
the source pin and fixtures, rebuild, and repeat verification; do not track a
moving branch silently.

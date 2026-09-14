# NVIDIA Research exporter integration

The audit receiver supports the experimental [OpenShell Event Exporter](https://github.com/NVIDIA/OpenShell-Research/tree/main/projects/openshell-exporter)
under `projects/openshell-exporter/`. The quick start pins the tested, merged
commit `26dbfd52730429695670c27a0ec0449a851e755c` from that repository's `main`.
No pull-request checkout is required.
The exporter runs separately; the bridge does not vendor or execute its Go code.

Path: OpenShell OCSF / authorized WatchSandbox sources → exporter → authenticated
HTTPS CloudEvents batch → capture receiver → Slack audit cards and App Home.
Approvals still use the bridge's direct gateway connection, not the exporter.

## Build the merged source

Follow the [step-by-step quick start](exporter-quickstart.md), including its
absolute directory variables and separate gateway, Slack, sandbox, and exporter
steps. Build with `projects/openshell-exporter/` as the Docker context, not the
Research repository root. No NVIDIA-published exporter image is assumed.

The exporter uses standard Docker bridge networking and
`host.docker.internal` to reach the Mac; no Docker Desktop host-networking switch
is needed. Both gateway and capture certificates must cover their configured
endpoint hostnames. The example's runtime options are passed as environment
variables; preserve the same sandbox/workspace identities across components.

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

This optional developer check uses a synthetic fixture; the quick start's
deployment verification uses a real sandbox denial instead.

From `SLACK_DIR`, run `npm test`, `npm run typecheck`, and `npm run build`.
Receiver tests include an upstream synthetic fixture and verify batch backpressure.
For actual-image verification on Docker Desktop:

```sh
export CONTRACT_TLS_DIR="$SLACK_DIR/state/contract-tls"
node --import tsx "$SLACK_DIR/scripts/verify-research-exporter.ts" "$CONTRACT_TLS_DIR" "$EXPORTER_IMAGE"
```

Use the `SLACK_DIR` and `EXPORTER_IMAGE` variables from the quick start. Before
running this optional test, provision a dedicated TLS directory at
`CONTRACT_TLS_DIR` (or choose an existing test-only directory). It must contain
`ca.crt`, `slack-capture.crt`, and
`slack-capture.key`; the certificate must cover `host.docker.internal`.
The command creates an isolated receiver and temporary container, feeds one
synthetic event, verifies rendering, and removes its temporary resources. It
does not use Slack tokens, mount live exporter state, or call the Slack API.

## Experimental limitations

The pinned merged source includes delivery/privacy fixes and regressions for
original-log-attribute redaction and discovery cleanup. The example retains the
normalized `openshell` pipeline; it does not adopt `http.config.yaml`, which intentionally bypasses
normalization/redaction. Synthetic validation does not qualify sensitive data,
production capacity, every source lane, or ARM64 runtime operation. For future updates, intentionally update
the source pin and fixtures, rebuild, and repeat verification; do not track a
moving branch silently.

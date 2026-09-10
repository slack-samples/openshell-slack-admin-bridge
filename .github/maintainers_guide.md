# Maintainer's guide

This guide is for the maintainers of this sample.

## What this repo is

A Slack Bolt (TypeScript) app that brings OpenShell sandbox network-egress
approvals into Slack. See the [README](../README.md) for the architecture.

## Running the tests

```bash
npm ci
npm run typecheck
npm test
npm run build
```

CI runs the same steps on Node 20 and 22 for every push and pull request (see
`.github/workflows/ci.yml`).

## Releasing

This sample is not published to npm. "Releasing" means merging to `main`. The
demo assets referenced in the README are refreshed by hand when the UX changes.

## Triage

- Label issues as `bug`, `question`, or `enhancement`.
- Security reports must go through the process in [SECURITY.md](../SECURITY.md),
  never a public issue.

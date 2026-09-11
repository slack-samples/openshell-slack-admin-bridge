# Contributing

Thanks for your interest in contributing to this Slack sample. This document
explains how to propose changes.

## Reporting issues

Open a GitHub issue and include:

- what you expected to happen and what actually happened,
- clear steps to reproduce (a failing command or a minimal case),
- your Node.js version and OS.

For security issues, do not open a public issue. See [SECURITY.md](../SECURITY.md).

## Development setup

This is a TypeScript project targeting Node.js 22+.

```bash
npm install
npm run dev:mock    # terminal 1: in-memory OpenShell gateway
npm run dev         # terminal 2: the bridge, pointed at the mock (see README)
```

## Before you open a pull request

Run the full check suite locally and make sure it passes:

```bash
npm run typecheck
npm test
npm run build
```

Please keep pull requests focused, describe the motivation, and update the
README or docs when behavior changes.

## License

By contributing, you agree that your contributions will be licensed under the
MIT License in [LICENSE](../LICENSE).

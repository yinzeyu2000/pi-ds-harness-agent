# Upstream baseline

## Pi

- Upstream: `https://github.com/earendil-works/pi`
- Branch at capture: `main`
- Commit: `b8b873b9872db04a938fb4357b5e8e824ddc051c`
- Description: `v0.84.4-11-gb8b873b98`
- Captured: 2026-09-02 (Asia/Singapore)

## Toolchain

- Node.js: `v22.20.0`
- npm: `10.9.3`
- Pi engine floor: Node.js `>=22.19.0`
- Known optional-package warning: `@earendil-works/gondolin@0.12.0` asks for Node.js `>=23.6.0`.

## Reproduction

1. `npm install`
2. `npm run hydrate:model-data` (requires network; generated provider data is intentionally not tracked upstream)
3. `npm run build:offline`
4. `npm test`
5. `npm run check`

The complete first-run observations are in [docs/baseline-results.md](docs/baseline-results.md).

## Upstream policy

- Keep `upstream-pi` as the development remote during the MVP; the public repository contains a source snapshot rather than the complete Pi history.
- New composition code belongs under `packages/harness-runtime` and uses the `@pi-ds/*` namespace.
- Prefer adapters over changes to `packages/agent/src/agent-loop.ts`.
- Every source port inspired by DeepSeek Harness must be recorded in `docs/source-port-ledger.md`.

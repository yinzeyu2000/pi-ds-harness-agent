# ADR-001: Fixed source baselines and reuse boundaries

- Status: Accepted
- Date: 2026-09-03
- Milestone: M0

## Decision

The implementation baseline is Pi commit `b8b873b9872db04a938fb4357b5e8e824ddc051c` (`v0.84.4-11-gb8b873b98`). Its history, package layout, agent loop, model abstractions, TUI, protocol, client, server, and session backends are retained initially.

DeepSeek Harness commit `4e84901e6471b79ec0338099867ebb4606d12bb5` (`dsh-v0.1.2-alpha.4`) and Codex commit `b27a6321fa1a1dbb48e019d1d1296d2a13dc4261` (`rusty-v8-v150.4.0-1528-gb27a6321fa`) are behavior and design references. Code is ported selectively through the source-port ledger; neither tree is merged wholesale.

The old `pi+ds harness agent` prototype is evidence, not a baseline. Its observed commit is `9c4ceed4` on `codex/m3-jsonl-recovery`, with uncommitted work present at M0. Only small assets that pass provenance, architecture, and conformance review may be migrated.

## Consequences

- Every port records exact source path, commit, strategy, target, invariants, tests, and license disposition.
- Pi package names stay unchanged during M0; no mass rename or speculative refactor is allowed.
- Rust is not introduced into the TypeScript core merely to resemble Codex. A native sidecar requires an explicit later ADR and capability boundary.

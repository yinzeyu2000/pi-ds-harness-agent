# M0 foundation status

Date: 2026-09-03  
Branch: `codex/m0-baseline`  
Pi baseline: `b8b873b9872db04a938fb4357b5e8e824ddc051c`

## Completed locally

- Pi history retained and checked out at the fixed baseline commit.
- DeepSeek Harness, Codex Harness, and the old prototype registered as reference-only remotes.
- Source-port ledger and repository map created.
- Required M0 decisions ADR-001, 002, 003, 004, 005, 007, 008, 009, 011, and 012 accepted.
- Threat model, explicit non-goals, release gates, conformance/fault/protocol/security/soak test skeletons, and architecture guard created.
- Deterministic Fake LLM golden traces cover pure conversation, one tool, parallel multi-tool ordering, and streaming interruption.
- Dependency install, model-data hydration, static checks, and offline build executed successfully.
- Pi's upstream platform defects exposed by the Windows baseline are fixed: privilege-aware symlink tests, Git Bash discovery/path handling, Windows named pipes, quoted commands in paths containing spaces, process-tree timeout cleanup, and portable persisted paths.
- The complete isolated native Windows suite is green.
- Docker Desktop's WSL2 Linux engine was used only as a validation environment; Linux static checks plus focused Agent, Unix socket, external-editor, and persistence regressions pass.

## Open release gate

Docker Desktop is available and its focused Linux regression run is green, but the canonical Linux **full** suite has not yet executed locally. The checked-in Ubuntu CI job remains the repeatable full-green release gate. Docker/WSL is validation infrastructure and a possible future Sandbox Provider, not a runtime dependency of the lightweight Agent core.

## M0 boundary

M0 freezes names, ownership, durability boundaries, security posture, and source provenance. It intentionally does not yet port DSH modules, copy Codex Rust, rename Pi packages, or implement the new runtime. Those changes begin in M1 behind the architecture rules accepted here.

See [the measured baseline](docs/baselines/2026-09-03-m0.md) for commands, results, and known environmental constraints.

# Repository map and ownership boundary

## Baselines

| Role | Repository | Fixed revision | Use |
| --- | --- | --- | --- |
| Implementation baseline | Pi | `b8b873b9872db04a938fb4357b5e8e824ddc051c` | Retain history and evolve in place |
| Composition reference | DeepSeek Harness | `4e84901e6471b79ec0338099867ebb4606d12bb5` | Port patterns selectively |
| Industrial runtime reference | Codex | `b27a6321fa1a1dbb48e019d1d1296d2a13dc4261` | Reimplement behavioral invariants in TypeScript/platform adapters |
| Migration evidence | old prototype | `9c4ceed4` plus a dirty working tree | Inspect only; cherry-pick nothing wholesale |

Local remotes are `pi-upstream`, `dsh-reference`, `codex-reference`, and `prototype-reference`. Reference remotes are not merge sources. Updating a fixed revision requires a new ADR, a ledger review, refreshed golden traces, and a clean baseline run.

## Target tree at M0

- `packages/agent`: retained Pi loop; future adapter seam, not a host runtime.
- `packages/ai`: retained provider abstraction; future calls enter through ModelGateway.
- `packages/coding-agent`: retained CLI/TUI integration; becomes one protocol client.
- `packages/protocol`, `packages/client`, `packages/server`: retained transport foundation; evolve through versioned schemas.
- `packages/session-backends`: projection/storage implementations; never a second canonical source.
- Future `packages/runtime-*`: ThreadRuntime, Journal, broker, process, sandbox, approval, and plugin capability packages. Creation starts in M1/M2 after interfaces are frozen.
- `docs/adr`: binding architecture decisions.
- `tests/*`: cross-package acceptance suites.
- `tools/architecture-guards`: dependency/ownership enforcement.

## Ownership rule

The future call path is UI/transport → AgentHarness → ThreadRuntime mailbox → ModelGateway or ExecutionBroker → Journal → committed event fan-out. Reverse calls and direct shortcuts are forbidden.

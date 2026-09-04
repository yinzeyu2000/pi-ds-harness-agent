# Source-port ledger

Every imported idea or code fragment must be added here before implementation. `Behavioral` means reimplementation from externally observable guarantees; `Adapt` means a small TypeScript design is ported with attribution/license review; `Retain` is unchanged Pi code.

| Source | Fixed commit and path | Strategy | Intended target | Invariants to preserve | Acceptance evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Pi | `b8b873b… packages/agent/src/agent-loop.ts` | Retain | `packages/agent` | one reasoning loop; typed streaming; tool batches; steering/follow-up | M0 golden traces | Active baseline |
| Pi | `b8b873b… packages/ai` | Retain + wrap | ModelGateway adapter | provider-neutral messages; explicit abort/error terminal event | AI suite + gateway conformance | Planned M1 |
| Pi | `b8b873b… packages/coding-agent` | Retain + adapt | CLI/TUI client | existing interaction behavior; extension compatibility where safe | UI protocol tests | Planned M7 |
| Pi | `b8b873b… packages/session-backends/sqlite-node` | Adapt | projection store | rebuildable state; no canonical-write ownership | replay/projection parity | Planned M1/M7 |
| DSH | `4e84901… packages/core`, `packages/extensions`, `packages/boot` | Behavioral/Adapt | plugin host + capability registry | composable lifecycle; scoped disposal; explicit dependencies | plugin conformance | Planned M1/M6 |
| DSH | `4e84901… packages/session`, `packages/storage` | Behavioral | Journal/event schema | event-first recovery; typed session events | replay and crash matrix | Planned M1/M2 |
| DSH | `4e84901… packages/api/gateway/src/stream-protocol.ts` | Behavioral | protocol gateway | generation binding; lossless JSON; event/result correlation | reconnect/fuzz tests | Planned M7 |
| DSH | `4e84901… packages/acp/acp/src` | Behavioral | ACP/multi-UI adapter | committed event projections; approval correlation | ACP transcript fixtures | Planned M7 |
| Codex | `b27a632… codex-rs/core/src/codex_thread.rs` | Behavioral | ThreadRuntime | single coordinator; cancellation and lifecycle ownership | race/model-check suite | Planned M2 |
| Codex | `b27a632… codex-rs/core/src/exec.rs`, `codex-rs/exec` | Behavioral | ProcessManager/ExecutionBroker | supervised process tree; bounded output; deterministic terminal state | process conformance | Planned M3 |
| Codex | `b27a632… codex-rs/core/src/windows_sandbox.rs`, `codex-rs/windows-sandbox-rs` | Behavioral only | sandbox Windows adapter | explicit grants; fail-closed secure profile; process containment | Windows security suite | Research M4 |
| Codex | `b27a632… codex-rs/bwrap`, sandbox tests | Behavioral | sandbox Linux adapter | filesystem/network isolation; capability reporting | escape suite | Planned M4 |
| Codex | `b27a632… codex-rs/app-server-protocol`, `codex-rs/docs/protocol_v1.md` | Behavioral | versioned public protocol | request IDs; sequence resume; multiple UI clients | schema/golden/fuzz tests | Planned M7 |
| Codex | `b27a632… codex-rs/rollout`, `codex-rs/rollout-trace` | Behavioral | Journal/recovery diagnostics | append-only history; replay; repair visibility | crash/recovery suite | Planned M1/M2 |
| Old prototype | `9c4ceed4… packages/harness-runtime/src/events.ts`, `projections.ts` | Inspect/Adapt | Journal schema drafts | typed events and rebuildable projections only | architecture + replay tests | Review in M1 |
| Old prototype | `9c4ceed4… packages/harness-runtime/src/plugin-host.ts`, `plugin-sdk.ts` | Inspect/Adapt | plugin host drafts | explicit services; deterministic dispose; no authority escalation | plugin conformance | Review in M1/M6 |
| Old prototype | `9c4ceed4… packages/harness-runtime/src/tool-pipeline.ts`, `pi-agent-driver.ts` | Inspect/Rewrite | broker adapter | all tools cross one barrier; Pi loop stays sole loop | golden + fault injection | Review in M2 |

No row authorizes copying. Before a status changes to “Ported,” record the actual license notice, target commit, tests, and divergences.

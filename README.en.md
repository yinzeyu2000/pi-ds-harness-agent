# pi+ds harness agent

**English** | [简体中文](README.md)

A TypeScript Agent Harness that keeps [Pi](https://github.com/earendil-works/pi) as its execution foundation while adopting the composition ideas of DeepSeek Harness.

The project aims to preserve two qualities at the same time:

- Pi's small, readable, embeddable core;
- DeepSeek Harness-style composition, replayability, and reversible plugin lifecycles.

This project is in early development. The first development batch includes the plugin microkernel, Pi AgentDriver, an in-memory vertical slice, and offline conformance tests. It is not yet recommended for production use.

## Core principles

- **One Agent Loop:** the default driver wraps Pi Agent instead of implementing another execution loop.
- **One source of truth:** Pi Session Entry/LaneRecord remains the canonical log.
- **Reversible plugin contributions:** services, listeners, and background resources belong to a Plugin Scope and are released in reverse order.
- **A lightweight default:** the Minimal Profile loads only the model boundary, Memory Session, prompt, tools, and Pi AgentDriver.
- **Monotonic denial:** once a tool guard denies execution, later handlers cannot allow it again.

## Implemented

- Type-safe `ServiceToken` values and isolated service scopes;
- static plugin dependency ordering, missing-dependency checks, and cycle detection;
- single-provider conflict detection;
- transactional activation and rollback;
- `AbortSignal`, idempotent disposal, and LIFO effects;
- separate Durable Facts, Live Events, and Capability Middleware semantics;
- write-before-publish and a pure Projection Registry;
- deterministic Profile / Bundle / Patch composition;
- a fixed `pre/guard/approval/around/body/post/result` tool pipeline with headless fail-closed approval and structured stage errors;
- an opt-in `--harness-runtime` print/JSON/RPC CLI, per-tool terminal or RPC approval, and explicit Extension factory loading;
- one `CodingRuntimeController` and durable Projection shared by print, JSON, and strict JSONL RPC consumers;
- RPC prompt/queue/abort/resume/compaction, Extension commands, runtime configuration, tree query/navigation, and graceful shutdown;
- canonical session id/path/continue, image-bearing initial messages, and idle-time Tool/Model/thinking-level changes;
- Extension commands, Agent/Tool lifecycle bindings, pre-commit message transforms, and recoverable initial inputs;
- a scoped Tool Catalog with versioned policies included in recovery configuration anchors;
- scoped Prompt Contributors and an ephemeral Prompt View that does not create conversation messages;
- a Pi Models Provider with exact model selection and recovery-time model validation;
- parallel tool completion decoupled from durable ToolResult ordering, which always follows model call order;
- durable steer/follow-up queue facts, Assistant/Tool usage facts, and pending-queue restart recovery;
- Provider reconciliation for non-idempotent tools, while unknown outcomes remain fail-closed;
- `PiAgentDriver` prompt, abort, steer, and follow-up contracts plus a resumable Minimal Headless Runtime;
- injectable JSONL sessions, unfinished-operation classification, conservative resume, and unknown tool-effect blocking;
- versioned request-configuration anchors, recovery-time drift blocking, and one Memory/JSONL/SQLite `flush()` barrier;
- Pi Reducer-backed messages, turn-state, and tool-state projections;
- pre-body `tool_started` facts, stable ToolResult IDs, and `safe`/`never` recovery policies;
- an offline Fake Model + read-only Tool + Memory Session vertical test.

## Architecture

```text
Products / SDK / CLI
        │
        ▼
Profile / Bundle / Patch
        │
        ▼
PluginHost ── Service / Scope / Effect / Events
        │
        ▼
PiAgentDriver ── Pi Agent / agentLoop
        │
        ▼
Pi Session Entry + LaneRecord (single source of truth)
```

The new composition layer is located in [`packages/harness-runtime`](packages/harness-runtime). Existing Pi model, Agent, TUI, protocol, and Coding Agent package names remain unchanged during migration.

## Quick start

Requirements: Node.js 22.19 or later and npm.

```bash
git clone https://github.com/yinzeyu2000/pi-ds-harness-agent.git
cd pi-ds-harness-agent
npm install
npm run hydrate:model-data
npm run build:offline
npm test --workspace=@pi-ds/harness-runtime
```

Pi generates its model catalog outside Git, so `hydrate:model-data` must run once before the first offline build.

## Verification

- Repository-wide TypeScript, formatting, dependency, and browser bundle checks pass.
- The complete offline build passes.
- Harness Runtime: 9 test files and 51 tests pass without network or shell access.
- The complete upstream Pi test suite still exposes Windows-specific differences around Bash discovery, symlink privileges, Unix sockets, and path separators. See the [baseline test record](docs/baseline-results.md).

## Documentation

- [Execution plan](EXECUTION_PLAN.md)
- [Upstream baseline](UPSTREAM_BASELINE.md)
- [Architecture guardrails](docs/architecture.md)
- [Event model](docs/event-model.md)
- [M3 JSONL recovery handoff](docs/handoff-m3-jsonl-recovery.md)
- [M4 Tool/Prompt/Models handoff](docs/handoff-m4-tool-pipeline.md)
- [M5 plugin SDK and composition handoff](docs/handoff-m5-plugin-composition.md)
- [M6 first Coding Runtime handoff](docs/handoff-m6-coding-runtime.md)
- [Harness RPC protocol](docs/harness-rpc.md)
- [Source-port ledger](docs/source-port-ledger.md)
- [ADR: one Session and Agent Loop](docs/adr/0001-single-session-and-agent-loop.md)
- [ADR: PluginHost implementation](docs/adr/0002-plugin-host-implementation.md)
- [ADR: three event domains](docs/adr/0003-event-domains.md)

## Roadmap

The next priorities are:

1. make the TUI consume Harness Runtime and Projections without a second authoritative state;
2. complete cross-file session switching, Fork, summarized tree navigation, and the remaining Extension compatibility boundaries;
3. establish the legacy Pi CLI/RPC compatibility matrix and add protocol stress tests;
4. extend Coding Profile crash-injection and real interactive end-to-end coverage.

See [`EXECUTION_PLAN.md`](EXECUTION_PLAN.md) for the complete staged plan.

## Origin and license

This project is developed from a pinned Pi source snapshot. The public repository uses an independent, compact commit history and does not publish Pi's complete Git history. The new composition layer draws on DeepSeek Harness architecture concepts while using project-owned interfaces and implementation. References are recorded in the source-port ledger.

The repository retains the MIT License. Before public releases or commercial deployment, independently review all third-party dependencies and referenced implementations for compliance.

## Contributing

The architecture is still converging. Issues describing concrete use cases, bugs, and design feedback are welcome. New features should preserve the constraints of one Agent Loop, one source of truth, and one official plugin API.

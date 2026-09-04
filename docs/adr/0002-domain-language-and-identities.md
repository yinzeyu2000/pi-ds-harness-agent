# ADR-002: Domain language and globally distinct identities

- Status: Accepted
- Date: 2026-09-03
- Milestone: M0

## Decision

The containment vocabulary is `RuntimeHost > HostLifecycleCoordinator > ThreadManager > ThreadRuntime`. `AgentHarness` is the public façade; Pi's agent loop is the sole model/tool reasoning loop inside a `ThreadRuntime`.

Canonical terms are:

- **Thread**: durable user-visible conversation and execution history.
- **Session**: internal loaded residency only; never a second durable conversation identity.
- **Operation**: one externally admitted command.
- **Turn**: one user-initiated unit of agent work.
- **Step**: one model response plus its tool batch. Existing Pi `turn_start`/`turn_end` events map to Step at the runtime boundary until renamed by versioned adapters.
- **Item**: durable transcript/output unit.
- **Task**: execution scheduled by the broker.
- **ToolAttempt**: one dispatch attempt for a tool call.
- **Process**: one OS process lifetime owned by the runtime.

The runtime uses distinct branded identities for thread, lane, operation, turn, step, task, item, tool call, tool attempt, process, command, event, runtime generation, and controller epoch. Events also carry causation, correlation, and trace identities. Values may share one UUID/ULID representation but types and namespaces must not be interchangeable.

The architecture permanently keeps seven unique authorities:

1. one foreground state machine: `ThreadRuntime`;
2. one Agent loop: Pi `agentLoop`/`runAgentLoop`;
3. one canonical durable log: the Pi-derived Journal;
4. one audited model dispatch boundary: `ModelGateway`;
5. one effectful tool boundary: `ExecutionBroker`;
6. one project-owned public Plugin API, independent of its internal host implementation;
7. one public semantic protocol shared by the headless SDK, CLI, TUI, and future UIs.

## Consequences

No module may create a competing meaning for Thread, Session, Turn, or Step. Wire adapters may expose legacy Pi names but must map them explicitly and version the mapping.

# ADR-003: One authoritative runtime per loaded thread

- Status: Accepted
- Date: 2026-09-03
- Milestone: M0

## Decision

Exactly one `ThreadRuntime` owns mutable execution state for a loaded Thread. It owns the ordered mailbox, controller lease, active turn, broker, journal writer, projections, approvals, and process set. `ThreadManager` loads/unloads runtimes but cannot mutate thread state directly. `AgentHarness` delegates; it is not another coordinator.

Pi's agent loop remains the only Agent loop. The runtime injects a `RuntimeModelAdapter` and ExecutionBroker-wrapped tools into it. Plugins, transports, and UIs submit commands and observe committed events; they do not call the loop, journal, process launcher, or sandbox implementation directly.

## Consequences

This prevents dual coordinators, duplicate tool execution, and UI-specific state. A second runtime for the same Thread is a correctness failure and must be rejected or fenced by runtime generation.

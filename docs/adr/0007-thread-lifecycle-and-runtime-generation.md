# ADR-007: Thread lifecycle and runtime generation

- Status: Accepted
- Date: 2026-09-03
- Milestone: M0

## Decision

`HostLifecycleCoordinator` serializes not-loaded transitions: create, load, unload, delete, compact, and recover. Once loaded, commands flow through the ThreadRuntime mailbox.

Every load creates a monotonically advancing runtime generation. Async callbacks, timers, transports, approvals, and process exits capture that generation and are ignored if it is no longer current. Unload uses compare-and-remove against the exact generation. Resource pins prevent unload while an admitted operation, approval, journal flush, or owned process still requires the runtime.

## Consequences

Late callbacks cannot resurrect or mutate a replaced runtime. Lifecycle tests must cover load/unload races, stale cleanup, reconnects, and process exit after unload.

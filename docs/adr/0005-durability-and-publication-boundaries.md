# ADR-005: Durability and publication boundaries

- Status: Accepted
- Date: 2026-09-03
- Milestone: M0

## Decision

Three acknowledgements are distinct:

- **accepted**: the command passed admission and has an admission receipt.
- **persisted**: the fact is appended to the canonical Journal and visible to replay.
- **power-loss durable**: the configured durability barrier has completed.

Durable events are published to transports and projections only after their required persistence barrier. Dispatch intent for a non-read-only side effect is durable before execution. Terminal model, tool, process, approval, cancellation, and operation-result records cross the configured flush barrier before success is acknowledged.

## Consequences

Streaming deltas may be explicitly ephemeral, but they cannot masquerade as committed facts. Each profile declares its flush policy. Crash tests must prove there is no acknowledged-but-missing terminal state and no side effect without a prior durable intent.

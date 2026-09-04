# ADR-009: Model/tool attempts and dispatch barriers

- Status: Accepted
- Date: 2026-09-03
- Milestone: M0

## Decision

Every provider request is a `ModelAttempt`; every tool execution is a `ToolAttempt`. Attempts have durable intent, started, and one terminal outcome. Retries create new attempt identities linked to the same logical operation.

`ModelGateway` is the only model boundary. `ExecutionBroker` is the only tool/process boundary. The Pi loop receives only `RuntimeModelAdapter` and broker-wrapped tools, so plugins cannot bypass policy, approvals, sandboxing, accounting, cancellation, or persistence.

Non-idempotent work whose outcome cannot be proven after a crash terminates as `outcome_unknown`; it is never automatically retried. Read-only/idempotent retries require an explicit policy and attempt record. Tool-result publication waits for the broker's terminal durability barrier.

## Consequences

Retries and recoveries remain auditable. Failure injection must cover crash before intent, after intent/before dispatch, during execution, after side effect/before terminal record, and after terminal record/before publication.

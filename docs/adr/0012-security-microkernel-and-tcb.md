# ADR-012: Security microkernel and trusted computing base

- Status: Accepted
- Date: 2026-09-03
- Milestone: M0

## Decision

The following thirteen authorities cannot be replaced or bypassed by the public Plugin API:

1. identity, sequence, and command-deduplication allocation;
2. Thread/Turn/Step/ToolAttempt state machines;
3. the canonical Journal's sole append/flush entry;
4. durable-before-publish ordering;
5. ModelGateway's pre-dispatch barrier;
6. Tool Gateway and ExecutionBroker;
7. final monotonic permission merging;
8. approval-fingerprint validation;
9. the sandbox enforcement point;
10. process ownership, quotas, and process-tree cleanup;
11. exactly-once Turn terminal settlement;
12. protocol envelopes, schemas, and version negotiation;
13. PluginScope task supervision and shutdown ordering.

Together with their direct platform adapters, these authorities form the security microkernel.

These components and their direct platform adapters form the trusted computing base (TCB). Same-process plugins are also trusted code and are labeled as such. Plugins receive narrow capability interfaces and may reduce permissions but cannot grant themselves filesystem, network, model, process, approval, or Journal access beyond host policy.

Untrusted plugins require a future out-of-process protocol with authenticated capability grants. Transport/UI code, model providers, projections, and presentation plugins are outside the microkernel and cannot author committed security decisions.

## Consequences

Architecture guards reject direct process spawning, raw Journal writes, direct provider calls, and sandbox implementation imports outside approved packages. Security review can focus on a bounded TCB instead of the entire plugin ecosystem.

# Architecture guardrails

The first implementation batch establishes one new composition package: `@pi-ds/harness-runtime`.

Dependency direction:

```text
products / examples
        ↓
@pi-ds/harness-runtime
        ↓
Pi Agent + Pi AI + Pi Session
```

The following remain microkernel responsibilities and cannot be replaced by ordinary plugins:

- service-token identity and single-provider conflict detection;
- static dependency validation and cycle detection;
- transactional activation, scope cancellation and reverse disposal;
- the canonical session append boundary;
- monotonic denial before a tool body;
- exactly one selected AgentDriver per runtime.

Current rules:

- Pi Agent Core never imports `@pi-ds/*`.
- Harness Runtime never imports Coding Agent, TUI, SQLite or Node built-ins.
- `PiAgentDriver` adapts the existing Pi `Agent`; `agent-loop.ts` is unchanged.
- The Pi Session Entry/LaneRecord format remains the only durable fact model.
- A plugin may only provide services declared in its static manifest.
- Runtime instances own independent service scopes.

These rules are enforced by `test/architecture.test.ts` in the Harness Runtime package.

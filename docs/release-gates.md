# Release gates and explicit non-goals

## Functional MVP

Must provide the Pi agent experience through the new façade, one authoritative ThreadRuntime, canonical Journal and replay, ModelGateway, ExecutionBroker, supervised processes, approval binding, memory/JSONL profiles, plugin capability lifecycle, and the versioned local protocol. It must pass golden traces, conformance, recovery, and supported-platform functional tests.

It does **not** claim hostile-code isolation. It is not a distributed scheduler, hosted multi-tenant service, general container runtime, marketplace, or wholesale Codex/DSH clone.

## Secure Beta

Adds a fail-closed Linux secure sandbox profile, filesystem/network/process/resource boundaries, escape and symlink/TOCTOU suites, redaction tests, signed/effective capability reporting, and a documented TCB. Every unsafe fallback is explicit and auditable. Windows remains functional unless its equivalent security gate passes.

## Industrial v1

Adds stable protocol compatibility, multi-UI resume/controller semantics, durable idempotency receipts, migrations, projection rebuild tooling, soak/resource-leak gates, crash/fault matrices, operational diagnostics, and supported-platform upgrade/rollback procedures. It also requires published SLOs and a security review.

## Across all releases

We do not mass-rename Pi packages, merge reference repositories wholesale, make SQLite a second source of truth, allow plugins to bypass the broker/gateway, auto-retry ambiguous non-idempotent work, or advertise a sandbox guarantee that the active platform profile cannot prove.

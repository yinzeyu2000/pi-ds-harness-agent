# ADR 0002: project-owned plugin host for M1

- Status: accepted for MVP; reversible
- Date: 2026-09-02

## Decision

Use a compact project-owned `PluginHost` behind project-owned public contracts. Do not import Cordis in the first vertical slice.

## Alternatives

- Cordis Core adapter: retains mature Fiber semantics but adds a dependency and risks type leakage before the required surface is known.
- Two maintained hosts: rejected because it doubles lifecycle semantics and test cost.

## Consequences

The MVP implements only static manifests, required/optional services, DAG ordering, conflicts, transaction rollback, abort and reverse disposal. HMR, loaders and dynamic child plugins remain out of scope.

## Reversible condition

A Cordis adapter may replace the internals if it passes the same conformance tests without changing exported plugin types.

## Locked by

`plugin-host.test.ts`.

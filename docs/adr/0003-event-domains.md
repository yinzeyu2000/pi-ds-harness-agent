# ADR 0003: separate durable, live and middleware events

- Status: accepted
- Date: 2026-09-02

## Decision

Do not create a universal EventBus. Durable facts go through Session storage, live observations through `LiveEventBus`, and transformations/guards through explicit middleware helpers.

## Consequences

Recovery never replays live handlers or side effects. Observer failure isolation does not weaken monotonic safety guards. Write-before-publish can be tested independently.

## Locked by

`events-and-session.test.ts` and `profile-and-tools.test.ts`.

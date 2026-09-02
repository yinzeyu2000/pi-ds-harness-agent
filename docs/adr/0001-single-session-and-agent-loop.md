# ADR 0001: one Session fact source and one Agent Loop

- Status: accepted
- Date: 2026-09-02

## Decision

Pi `Agent`/`agentLoop` remains the execution primitive. Pi Session `Entry`/`LaneRecord` remains the canonical durable model. The new `PiAgentDriver` adapts them; no second loop or DeepSeek-style duplicate session log is introduced.

## Consequences

Existing Pi behavior stays readable and updateable. Harness features must enter through adapters, plugins and Session extensions. The Coding Agent migration cannot retain a second authoritative state store.

## Reversible condition

A replacement driver is allowed only when it passes the same lifecycle conformance suite and each runtime selects exactly one driver.

## Locked by

`vertical.test.ts` verifies a real Pi tool cycle, one terminal operation fact and reconstruction from the same Session.

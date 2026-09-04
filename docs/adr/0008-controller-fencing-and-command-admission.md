# ADR-008: Controller fencing and command admission

- Status: Accepted
- Date: 2026-09-03
- Milestone: M0

## Decision

Each loaded Thread has one ordered command mailbox and at most one controller lease. A successful controller acquisition advances a controller epoch; commands and approval answers from a stale epoch are rejected.

The idempotency key is `(principalId, threadId, method, clientRequestId)`. The admission receipt also stores a canonical payload hash. Repeating the same key and hash returns the recorded admission/result; repeating the key with a different hash is a protocol error.

Only one Turn may execute per Thread. `turn/start` while active is rejected as busy in the initial protocol; `turn/steer` is the explicit way to affect the active Turn. A future queue policy requires a versioned capability and ADR. Admission and final result receipts are journaled.

## Consequences

Multiple UIs may observe one Thread, but only the current controller can mutate it. Reconnects are safe through receipts, sequence resume, and epoch fencing rather than best-effort socket state.

# Event model v0

The first batch implements three intentionally separate mechanisms:

1. Durable facts use Pi Session `Entry` and `LaneRecord`. `PiAgentDriver` appends an operation start, model-visible messages and exactly one operation finish.
2. Live events use `LiveEventBus`. Observer failures are reported and isolated; they do not prevent later observers from running.
3. Capability middleware uses explicit helpers: next-once waterfall, parallel barrier and monotonic guards.

Durable append precedes publication through `ObservableFactLog`. Projection functions receive facts and return state without access to runtime services. Replaying the same fact list must produce the same value.

Token deltas remain live-only. Final user, assistant and tool-result messages are durable. Optional `undefined` object fields produced by Pi message helpers are normalized to absent properties at the driver boundary because JSON has no `undefined` representation; `undefined` array elements remain an error.

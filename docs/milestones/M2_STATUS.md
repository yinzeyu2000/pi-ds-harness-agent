# M2 Minimal Vertical Runtime Status

Date: 2026-09-03  
Branch: `codex/m0-baseline`  
Baseline commit: `b8b873b9872db04a938fb4357b5e8e824ddc051c`

## Completed Deliverables

### 1. In-Memory Canonical Journal & Projection (`packages/agent/src/runtime/journal/`)
- **MemoryJournalWriter & MemoryJournalStore** (`memory-journal.ts`):
  - In-memory implementation of canonical single journal store and writer conforming to M1 contracts.
  - Generates monotonic sequence numbers (`seq >= 1`) and deterministic event IDs.
  - Produces three-tier receipts: `AcceptedReceipt`, `PersistedReceipt`, `PowerLossDurableReceipt`.
  - Supports atomic batch append, watermark advancement, checkpointing, and `afterSeq` incremental replay.
- **Canonical Projection** (`projection.ts`):
  - Pure function `projectThreadSnapshot(threadId, envelopes)` folding journal facts into `ThreadSnapshot`.
  - Accurately tracks durable watermark, active turn state, and thread lifecycle state.

### 2. Thread Mailbox & Fencing (`packages/agent/src/runtime/thread/`)
- **LoadedThreadMailboxImpl** (`mailbox.ts`):
  - Single ordered FIFO message queue for loaded threads.
  - In-memory deduplication table keyed on `(principalId, threadId, method, clientRequestId)`.
  - Pure BigInt FNV-1a payload hash comparison: matching hash returns cached receipt/result; conflicting payload hash throws `CommandDeduplicationConflictError`.
  - Active controller epoch fencing verification throwing `ControllerFencingError` on epoch mismatch.

### 3. ThreadRuntime & Lifecycle Coordinator (`packages/agent/src/runtime/thread/` & `runtime-host/`)
- **ThreadRuntimeImpl** (`thread-runtime-impl.ts`):
  - **Single ActiveTurn Exclusivity**: strictly enforces that a thread cannot start a new turn while an active turn is running, throwing `ActiveTurnConflictError`.
  - **Fast Turn Admission**: records `turn.admitted` fact and emits `turn.admitted` wire event, returning `AdmittedTurn` immediately before launching background execution.
  - **Exactly-Once Terminal Settlement**: compare-and-swap guard guarantees that competing completions/interruptions commit and emit exactly one terminal fact (`turn.completed`, `turn.interrupted`, or `turn.failed`).
  - **Observer Event Bus**: supports multiple concurrent subscribers via `subscribe(listener)`.
- **HostLifecycleCoordinatorImpl** (`lifecycle-coordinator-impl.ts`):
  - Coordinates thread operations (`start`, `resume`, `unload`, `archive`, `delete`).
  - Manages monotonic `RuntimeGeneration` and generation compare-and-remove fencing.
  - Manages residency pins (`pinThread`, `unpinThread`) and bounded shutdown (`shutdownAll`).
- **RuntimeHostImpl** (`runtime-host-impl.ts`):
  - Top-level runtime container managing loaded thread runtimes and lifecycle coordination.

### 4. Audited Adapters: Model Gateway & Execution Broker (`packages/agent/src/runtime/adapters/`)
- **FakeModelGateway & RuntimeModelAdapterImpl** (`fake-model-gateway.ts`):
  - Deterministic model streaming adapter supporting multi-turn and tool-calling loops.
  - Enforces pre-dispatch barrier: flushes `model.dispatch_intent` before generating stream output.
- **MemoryExecutionBroker** (`memory-execution-broker.ts`):
  - Minimal in-memory broker facade wrapping tools.
  - Manages tool attempt lifecycle: `prepareAction`, `onAttemptPrepared`, `onDispatchIntent`, `onExecutionStarted`, in-process execution, and `onAttemptSettled`.
  - Pure in-memory execution without OS child processes or real disk writes.

### 5. Pi AgentDriver & Event Translator (`packages/agent/src/runtime/driver/`)
- **PiEventTranslator** (`pi-event-translator.ts`):
  - Translates Pi `turn_start` -> `step.started`
  - Translates Pi `turn_end` -> `step.completed`
  - Translates Pi `message_end` -> committed assistant message entry
  - Translates Pi `agent_end` -> canonical terminal fact
- **PiAgentDriver** (`pi-agent-driver.ts`):
  - Connects Pi's core `runAgentLoop` with `RuntimeModelAdapter` and broker-wrapped tools.
  - Drives full closed loop: `Prompt -> Turn admitted -> Pi model request -> In-memory Tool -> Second model request -> Final message -> Terminal completed`.

### 6. Headless Client SDK (`packages/agent/src/runtime/client/`)
- **HeadlessClient** (`headless-client.ts`):
  - In-process programmatic client allowing applications to embed the runtime without CLI or TUI dependencies.

---

## Verification Results

1. **Vertical Closed Loop (`vertical-closed-loop.test.ts`)**:
   - `Prompt -> Turn admitted -> Fake Model -> Tool call -> Broker execute -> Second Model -> Final Message -> Terminal Completed` passed.
2. **ActiveTurn Exclusivity (`active-turn-exclusivity.test.ts`)**:
   - Starting a second turn while one is active reliably throws `ActiveTurnConflictError`.
3. **100-Iteration Interrupt vs Complete Race (`interrupt-terminal-race.test.ts`)**:
   - 100 concurrent race iterations verified: exactly one terminal event emitted and exactly one terminal fact recorded per turn, zero dual terminal states.
4. **Dual Observers (`dual-observers.test.ts`)**:
   - Two independent observers listening to the same runtime receive identical ordered wire events.
5. **Memory Journal & Projection (`memory-journal.test.ts`)**:
   - Verified 3-tier receipts, monotonic sequence numbers, replay and projection equality.
6. **Architecture Guard**:
   - `tools/architecture-guards/check-m2-runtime.mjs` passed (16 required artifacts verified, pure in-memory broker, single active turn guard).
7. **Quality Gate**:
   - `npm run check` passed completely (1156 files checked, 0 errors, 0 warnings, browser smoke build bundle passed).

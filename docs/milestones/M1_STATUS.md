# M1 Contracts, State Machines, Protocol v2, and Plugin SDK Status

Date: 2026-09-03  
Branch: `codex/m0-baseline`  
Baseline commit: `b8b873b9872db04a938fb4357b5e8e824ddc051c`

## Completed Deliverables

### 1. Protocol v2 & Branded Identifiers (`packages/protocol/src/v2`)
- **Branded Identifiers** (`branded-ids.ts`):
  - Strictly typed domain IDs preventing cross-domain assignment: `ThreadId`, `LaneId`, `OperationId`, `TurnId`, `StepId`, `TaskId`, `ItemId`, `ToolCallId`, `ToolAttemptId`, `ProcessId`, `CommandId`, `ClientRequestId`, `EventId`, `RuntimeGeneration`, `ControllerEpoch`, `CausationId`, `CorrelationId`, `TraceId`.
  - TypeBox schemas and factory assertion functions with prefix validations.
- **Durability Receipts & Cursors** (`cursor.ts`):
  - Receipts: `AcceptedReceipt`, `PersistedReceipt`, `PowerLossDurableReceipt`.
  - Cursors: `DurableCursor` (gapless replay) and `LiveCursor` (best-effort live stream).
- **Two-Phase Handshake & Capabilities** (`capabilities.ts`):
  - `ClientHelloV2`, `ServerHelloV2`, and `InitializedNotificationV2`.
  - Protocol version 2 negotiation and feature flags (`streamingDeltas`, `approvalPrompts`, `controllerLease`, `binaryFrames`, `processInteractivePty`).
- **Fenced Controller Lease** (`controller.ts`):
  - `ControllerLease`, `AcquireControllerCommand`, `ReleaseControllerCommand`.
  - Epoch fencing verification preventing split-brain writes.
- **Command Deduplication & Payload Hashing** (`dedupe.ts`):
  - Key: `(principalId, threadId, method, clientRequestId)`.
  - Pure BigInt 64-bit FNV-1a hashing (`computePayloadHash`), strictly zero Node-native crypto dependencies to guarantee browser build safety.
- **Wire Projections & Schemas** (`wire-types.ts`, `schemas.ts`, `index.ts`):
  - Public UI wire models: `ThreadSnapshot`, `TurnSnapshot`, `StepSnapshot`, `ItemSnapshot`, `ToolAttemptSnapshot`, `ProcessSnapshot`, `ApprovalRequestSnapshot`.
  - Envelopes: `WireEventEnvelope`, `LiveEventEnvelope`, `ProtocolV2RequestEnvelope`, `ProtocolV2ResponseEnvelope`.
  - Clean export alongside v1 from `packages/protocol/src/index.ts`.

### 2. Core Runtime Contracts & Pure State Machines (`packages/agent/src/runtime`)
- **Error Taxonomy** (`types/errors.ts`):
  - Full structured taxonomy: `UserToolError`, `PolicyDeniedError`, `ApprovalDeniedError`, `SandboxUnsupportedError`, `SandboxViolationError`, `ExecutionFailedError`, `RuntimeInvariantError`, `OutcomeUnknownError`, `ControllerFencingError`, `CommandDeduplicationConflictError`, `InvalidStateTransitionError`, `ActiveTurnConflictError`.
- **Canonical Single Journal** (`types/journal.ts`):
  - Single Journal envelope, draft, and discriminated records (`entry`, `lane`, `runtime_fact`).
  - Runtime facts: `TurnFact`, `StepFact`, `ModelAttemptFact`, `ToolAttemptFact`, `ApprovalFact`, `ProcessFact`, `ConfigurationFact`.
  - `ThreadJournalStore` and `JournalWriter` interfaces with 3 durability receipt tiers.
- **Pure State Machine Models** (`state-machines/`):
  - Transition tables: `THREAD_DURABLE_TRANSITIONS`, `THREAD_RESIDENCY_TRANSITIONS`, `TURN_PHASE_TRANSITIONS`, `STEP_PHASE_TRANSITIONS`, `MODEL_ATTEMPT_TRANSITIONS`, `TOOL_ATTEMPT_TRANSITIONS`, `PROCESS_PHASE_TRANSITIONS`.
  - Pure state machine classes: `ThreadStateMachine` (durable & residency), `TurnStateMachine`, `StepStateMachine`, `ModelAttemptStateMachine`, `ToolAttemptStateMachine`, `ProcessStateMachine`.
  - Invariant validation throwing `InvalidStateTransitionError` on illegal state transitions.
- **Authority & Microkernel Boundaries** (`types/`):
  - `RuntimeHost` and `HostLifecycleCoordinator` (generation compare-and-remove, thread residency pins, bounded shutdown).
  - `ThreadRuntime` and `LoadedThreadMailbox` (single mailbox, active turn exclusivity).
  - `AgentDriver` and deterministic `FakeDriver`.
  - `ModelGateway` and `RuntimeModelAdapter` (mandatory `model.dispatch_intent` pre-dispatch barrier).
  - `ExecutionBroker` and `ToolAttemptCoordinator` (sole effectful boundary, single submitter of tool facts).
  - Providers: `WorkspaceFSProvider`, `NetworkProvider`, `ProcessSupervisor`, `SandboxProvider` (with fail-closed `DefaultDenySandboxProvider`), `ApprovalManager`.

### 3. Plugin SDK & Cordis Spike Evaluation (`packages/agent/src/runtime/plugin/`)
- **Self-Hosted PluginHost**:
  - Branded `ServiceToken<T>`, `PluginManifest`, `Plugin`, `PluginContext`, `Effect`, `ManagedTask`.
  - `ServiceScope`: Hierarchical resolution (`RuntimeScope -> ThreadScope -> TurnScope -> TaskScope`).
  - `EffectScope`: Immediate registration, LIFO disposal, rollback on activation error, idempotent disposal, `AggregateError` aggregation.
  - `PluginHost`: Dependency DAG topological sorting, cycle detection, duplicate/missing provider detection, transactional activation rollback.
- **Cordis Spike Comparison & Decision** (`docs/spikes/cordis-vs-self-host.md`):
  - Spike adapter `CordisSpikeHost` created and benchmarked against `PluginHost`.
  - Formal architectural decision accepted: retain Self-Hosted `PluginHost` (11x faster startup, 8x smaller footprint, zero Proxy overhead, zero type leakage into public SDK).

---

## Verification Results

1. **Unit & Conformance Tests** (Vitest):
   - `packages/protocol/test/v2/protocol-v2.test.ts` (5 tests passed)
   - `packages/protocol/test/v2/fixtures.test.ts` (3 tests passed)
   - `packages/agent/test/runtime/state-machines.test.ts` (18 tests passed)
   - `packages/agent/test/runtime/plugin-host.test.ts` (7 tests passed)
   - `packages/agent/test/runtime/cordis-spike.test.ts` (2 tests passed)
   - `packages/agent/test/runtime/sandbox-contracts.test.ts` (2 tests passed)
   - **Total**: 37 tests passed, 0 failures.
2. **Architecture Guard**:
   - `tools/architecture-guards/check-m1-contracts.mjs` (26 required artifacts verified, zero forbidden Cordis imports in public SDK, pure state machines).
3. **Repository Checks**:
   - `npm run check` passed completely (0 errors, 0 warnings, browser smoke build bundle passed).

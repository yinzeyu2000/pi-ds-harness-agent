# M5 ExecutionBroker and Process Runtime Status

Date: 2026-09-04  
Branch: `codex/m0-baseline`  
Baseline commit: `b8b873b9872db04a938fb4357b5e8e824ddc051c`

## Completed Deliverables

### 1. Bounded Output Ring Buffer & Incremental Cursor (`packages/agent/src/runtime/process/output-buffer.ts`)
- **Monotonic Sequence Assignment**:
  - Every stdout/stderr chunk receives a strictly monotonic sequence number (`seq >= 1`), data payload, stream identifier, and timestamp.
- **Output Flood Protection & Head-Drop Truncation**:
  - Enforces hard ceiling on buffered output bytes (e.g. 512KB).
  - When output exceeds capacity, oldest chunks are evicted (head-drop), setting `truncated: true` and accumulating exact `truncatedBytes` metadata. Memory exhaustion from unbounded output floods is strictly prevented.
- **Incremental Cursor & Long-Polling**:
  - `read(options)` supports incremental consumption via `afterSeq`, byte limits via `maxBytes`, and non-busy long-polling via `waitMs`.

### 2. Opaque ProcessId & Process Registry (`packages/agent/src/runtime/process/process-registry.ts`)
- **Decoupled Wire Identity**:
  - Process identity uses unguessable, non-reusable `ProcessId` (`proc_<timestamp>_<counter>`), decoupling external wire identity from operating system PIDs.
  - Generational fencing ensures late events from dead processes cannot contaminate new processes.
- **Process Ownership (Foreground vs. Background)**:
  - Default foreground processes belong to the active `TurnId`.
  - Interrupting or aborting a Turn invokes `terminateTurnProcesses(turnId)` to automatically terminate its foreground process tree.
  - Background processes (promoted to `ThreadId`) survive Turn transitions subject to thread-level residency limits.

### 3. Node ProcessSupervisor & Termination Protocol (`packages/agent/src/runtime/process/process-supervisor-impl.ts`)
- **Process Spawning & Piping**:
  - Implements `ProcessSupervisor` via `node:child_process.spawn`.
  - Direct executable arguments without shell mangling, piping stdout/stderr into the `BoundedOutputBuffer`.
  - Supports process timeout with orthogonal `timedOut: true` flag.
- **Strict TERM -> KILL -> Await Termination Protocol**:
  - Refuses "fire-and-forget" termination.
  - Sequence: marks process terminating -> sends graceful `SIGTERM` -> awaits grace period -> sends force `SIGKILL` -> awaits OS process exit confirmation.
  - If process exit cannot be confirmed within deadline, accurately reports `terminationFailed: true`.
  - Reports orthogonal outcome flags: `exitCode`, `signal`, `timedOut`, `aborted`, `outputTruncated`, `terminationFailed`.

### 4. Industrial ExecutionBroker & Write-Before-Execute Barrier (`packages/agent/src/runtime/adapters/execution-broker-impl.ts`)
- **Action Preparation & Normalization**:
  - `prepareAction` classifies actions into `process`, `fs_read`, `fs_write`, or `compute`.
- **Write-Before-Execute Barrier**:
  - Strict sequence: `attempt_prepared` -> `policy check` -> `onDispatchIntent` (flushed to durable journal barrier) -> `execution_started` -> execution -> `onAttemptSettled`.
  - Guarantees `tool.execution_dispatch_intent` is flushed to disk before OS process execution or external side-effects commence, preventing duplicate executions across crash windows.
- **Policy Denial**:
  - Security policy rejections immediately halt the pipeline before dispatch intent and without spawning the process.

---

## Verification Results

1. **Unit & Integration Tests** (Vitest):
   - `packages/agent/test/runtime/output-buffer.test.ts` (4 tests passed: monotonic seq, head-drop flood truncation, cursor read, long-poll)
   - `packages/agent/test/runtime/process-supervisor.test.ts` (4 tests passed: process spawn & stdout capture, timeout handling, strict TERM->KILL->await protocol, dead ProcessId event isolation)
   - `packages/agent/test/runtime/execution-broker.test.ts` (2 tests passed: write-before-execute flush barrier, policy rejection)
   - **Total M5 Tests**: 10 tests passed, 0 failures.
   - **Cumulative Runtime Tests**: 20 test files, 64 tests passed.
   - **Cumulative Protocol v2 Tests**: 2 test files, 8 tests passed.
2. **Architecture Guards**:
   - `check-m0-baseline.mjs`: 16 required artifacts OK.
   - `check-m1-contracts.mjs`: 26 verified artifacts OK.
   - `check-m2-runtime.mjs`: 16 verified artifacts OK.
   - `check-m3-persistence.mjs`: 8 verified artifacts OK.
   - `check-m4-plugins.mjs`: 8 verified artifacts OK.
   - `check-m5-processes.mjs`: 7 verified artifacts OK (browser-safe buffer/registry, write-before-execute barrier, termination protocol).
3. **Golden Traces**:
   - `scripts/m0-golden-traces.ts`: 4 scenarios match baseline golden traces.
4. **Repository Quality Gate**:
   - `npm run check`: 1180 files checked, 0 errors, 0 warnings.
   - TypeScript compiler (`tsgo --noEmit`): OK.
   - Browser smoke build bundle (`check:browser-smoke`): OK.

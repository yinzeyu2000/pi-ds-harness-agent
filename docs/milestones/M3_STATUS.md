# M3 Canonical Journal, Persistence, Blob Store, and Fault Recovery Status

Date: 2026-09-04  
Branch: `codex/m0-baseline`  
Baseline commit: `b8b873b9872db04a938fb4357b5e8e824ddc051c`

## Completed Deliverables

### 1. Canonical JSONL Journal Store & File Fencing (`packages/agent/src/runtime/journal/jsonl-journal.ts`)
- **Exclusive Writer File Locking** (`.lock`):
  - Enforces cross-process single-writer exclusivity per thread using atomic lockfiles.
  - Concurrent attempt to open an active thread immediately fails with a lock conflict error.
- **Three Durability Receipt Tiers**:
  - `AcceptedReceipt` (`append`): Atomically allocates monotonic sequence numbers (`seq >= 1`) and deterministic event IDs.
  - `PersistedReceipt` (`persist`): Serializes buffered envelopes to disk file with trailing newlines and updates readable watermark.
  - `PowerLossDurableReceipt` (`flush`): Executes physical `fsync` (`fileHandle.sync()`) barrier on the file descriptor.
- **Checkpoints & Snapshot Files**:
  - `checkpoint()` serializes state snapshots to `<storageDir>/threads/<threadId>/checkpoints/<seq>.json`.
- **Fault Recovery & Corruption Protection**:
  - **Torn-tail Recovery**: Incomplete half-written records at the end of the log (simulating sudden power loss or process crash during disk write) are cleanly detected and truncated to the last valid record.
  - **Mid-log Corruption Fail-Closed**: Any corrupted record or sequence gap in the middle of the log immediately throws `RuntimeInvariantError`, strictly rejecting silent data loss or corrupted state progression.

### 2. Content-Addressed Blob Store (`packages/agent/src/runtime/journal/blob-store.ts`)
- **Content-Addressed Storage** (`FileBlobStore`):
  - Stores large tool outputs, images, and process spill buffers in `<storageDir>/blobs/<hash[0..2]>/<hash>`.
  - Content addressing via SHA-256 hash producing `BlobRef` with URI `blob://<hash>`.
- **Write-Before-Publish Guarantee**:
  - Blob files are written and fsynced to disk *before* any Journal Envelope references the `blobUri` / `outputHash`, guaranteeing that referencing records never point to unwritten data.

### 3. Crash Recovery Matrix & Projection Parity (`packages/agent/src/runtime/journal/recovery.ts`)
- **Incomplete In-Flight Settlement** (`recoverThread`):
  - Scans journal envelopes to identify uncompleted operations from unexpected process termination:
    - Incomplete `model_attempt` without completed status -> commits `outcome_unknown` (prevents duplicate billing).
    - Incomplete `tool_attempt` without result -> commits `outcome_unknown` (strictly guarantees non-idempotent side effects are never re-executed).
    - Incomplete `turn` without terminal status -> commits `turn.interrupted`.
- **Pure Replay & Projection Parity**:
  - Replay from Journal is strictly a pure projection function (zero execution of commands, tools, or processes).
  - `assertProjectionParity(online, replay)` verifies that live in-memory runtime snapshots match cold replay projections.

### 4. Rebuildable Secondary Thread Index (`packages/agent/src/runtime/journal/thread-index.ts`)
- **Secondary Query Index** (`RebuildableThreadIndex`):
  - Indexes thread metadata (title, durable status, item count, creation & update timestamps, watermarks) for fast search and pagination.
  - Operates strictly as a read-only projection with zero write authority over facts.
  - **100% Lossless Rebuild**: `rebuildFromStore(store, threadIds)` completely reconstructs the index from raw JSONL journals; deleting the index file causes zero data loss.

### 5. Node vs. Universal Runtime Architecture Packaging
- Maintained clean separation between browser-safe runtime contracts (`packages/agent/src/runtime/index.ts`, exported via `@earendil-works/pi-agent-core`) and Node-specific storage backends (`packages/agent/src/runtime/node.ts`, exported via `@earendil-works/pi-agent-core/node`).
- Guaranteed 100% browser build bundle safety (`check:browser-smoke`).

---

## Verification Results

1. **Unit & Integration Tests** (Vitest):
   - `packages/agent/test/runtime/jsonl-journal.test.ts` (3 tests passed)
   - `packages/agent/test/runtime/fault-recovery.test.ts` (3 tests passed)
   - `packages/agent/test/runtime/blob-store.test.ts` (2 tests passed)
   - `packages/agent/test/runtime/thread-index.test.ts` (1 test passed)
   - **Total M3 Tests**: 9 tests passed, 0 failures.
   - **Cumulative Runtime Tests**: 13 test files, 45 tests passed.
   - **Cumulative Protocol v2 Tests**: 2 test files, 8 tests passed.
2. **Architecture Guards**:
   - `check-m0-baseline.mjs`: 16 required artifacts OK.
   - `check-m1-contracts.mjs`: 26 verified artifacts OK.
   - `check-m2-runtime.mjs`: 16 verified artifacts OK.
   - `check-m3-persistence.mjs`: 8 verified artifacts OK (fail-closed corruption, fsync barrier, outcome_unknown recovery).
3. **Golden Traces**:
   - `scripts/m0-golden-traces.ts`: 4 scenarios match baseline golden traces.
4. **Repository Quality Gate**:
   - `npm run check`: 1165 files checked, 0 errors, 0 warnings.
   - TypeScript compiler (`tsgo --noEmit`): OK.
   - Browser smoke build bundle (`check:browser-smoke`): OK.

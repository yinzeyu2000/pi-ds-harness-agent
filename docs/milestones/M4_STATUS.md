# M4 Formal Plugin Composition Status

Date: 2026-09-04  
Branch: `codex/m0-baseline`  
Baseline commit: `b8b873b9872db04a938fb4357b5e8e824ddc051c`

## Completed Deliverables

### 1. Manifest & Semver Constraint Resolution (`packages/agent/src/runtime/plugin/manifest.ts`, `plugin-host.ts`)
- **Semantic Versioning Constraints**:
  - Implemented pure TypeScript semver parsing and range evaluation (`parseSemver`, `matchesSemver`) supporting exact versions, caret ranges (`^1.0.0`), tilde ranges (`~1.0.0`), and comparison ranges (`>=1.0.0`).
  - Strict zero external dependency footprint ensuring 100% browser build safety.
- **Topological DAG Ordering & Conflict Validation**:
  - Validates required service versions against provider versions during DAG resolution.
  - Rejects circular dependencies, duplicate providers, and incompatible version ranges before activating any plugin.

### 2. Hierarchical Scope Lifecycle & Cascading LIFO Disposal (`packages/agent/src/runtime/plugin/scopes.ts`)
- **4-Tier Ownership Hierarchy**:
  - `RuntimeScope`: Global providers, model gateway, storage factories, platform capabilities.
  - `ThreadScope`: Thread plugin state, tool registrations, background subscriptions.
  - `TurnScope`: Active turn context, cancellations, ephemeral resources.
  - `TaskScope`: Localized execution tasks.
- **Cascading Reverse LIFO Disposal**:
  - Disposing a parent scope (e.g. `ThreadScope`) recursively disposes all child scopes (`TurnScope`, `TaskScope`) and their registered effects in strict reverse LIFO order.
  - Parent scope remains unaffected when child scopes are independently disposed.

### 3. Managed Resources & Transactional Rollback (`packages/agent/src/runtime/plugin/context.ts`, `plugin-host.ts`)
- **Real-Time Managed Effects**:
  - `PluginContext` provides `defer`, `use`, `listen`, `task`, `timer`, `provide`, `require`, `get`.
  - Tasks and timers are bound to scope abort signals and automatically cleared on scope exit.
- **Zero-Residual Transactional Activation Rollback**:
  - If plugin #N fails during activation, all partial registrations in plugin #N and all previously activated plugins (1..N-1) are rolled back in reverse order, returning active resource counts strictly to 0.
  - Disposal errors are collected and reported via `AggregateError` without interrupting remaining cleanups.

### 4. Standard Service Seams (`packages/agent/src/runtime/plugin/services.ts`)
- Standard branded `ServiceToken`s:
  - `MODELS_SERVICE`: Model gateway / providers.
  - `TOOLS_SERVICE`: Tool catalog and registry.
  - `PROMPT_SERVICE`: Prompt contributor catalog.
  - `SESSION_SERVICE`: Canonical journal store.
  - `BROKER_SERVICE`: Execution broker.
  - `DRIVER_SERVICE`: Agent driver.

### 5. Profiles, Bundles, Patches & Deterministic Manifest Hashing (`packages/agent/src/runtime/plugin/profile.ts`)
- **Profile Composition Engine**:
  - `composeProfile(profile, bundles)` applies `insert`, `replace`, `disable`, `mergeConfig`, and `replaceConfig` patches deterministically.
- **Deterministic Manifest Hashing**:
  - `computeManifestHash` calculates a reproducible 64-bit FNV-1a hash over normalized profile plugin configurations. Identical combinations produce identical manifest hashes.
- **Standard Pre-configured Profiles**:
  - `MINIMAL_PROFILE`: Pi Driver + Memory/JSONL + minimal tools.
  - `TEST_PROFILE`: Fake Model + Fake Tools + failure injection.
  - `CODING_PROFILE`: Coding tools, bash, approval, sandbox.

### 6. Legacy Pi Extension Compatibility Adapter (`packages/agent/src/runtime/plugin/extension-adapter.ts`)
- `adaptLegacyExtension(name, factory)` wraps legacy Pi extensions (`(ctx: ExtensionContext) => void | Promise<void>`) into standard `Plugin`s, routing tool registrations to `TOOLS_SERVICE` and lifecycle hooks to plugin scopes.

---

## Verification Results

1. **Unit & Integration Tests** (Vitest):
   - `packages/agent/test/runtime/plugin-composition.test.ts` (5 tests passed: semver DAG, semver rejection, transactional rollback to 0, AggregateError, multi-instance isolation)
   - `packages/agent/test/runtime/plugin-scopes.test.ts` (1 test passed: 4-tier hierarchy, upward resolution, cascading LIFO disposal)
   - `packages/agent/test/runtime/profile.test.ts` (2 tests passed: bundle composition, patches, deterministic manifest hash equality)
   - `packages/agent/test/runtime/extension-adapter.test.ts` (1 test passed: legacy Pi extension tool registration)
   - **Total M4 Tests**: 9 tests passed, 0 failures.
   - **Cumulative Runtime Tests**: 17 test files, 54 tests passed.
   - **Cumulative Protocol v2 Tests**: 2 test files, 8 tests passed.
2. **Architecture Guards**:
   - `check-m0-baseline.mjs`: 16 required artifacts OK.
   - `check-m1-contracts.mjs`: 26 verified artifacts OK.
   - `check-m2-runtime.mjs`: 16 verified artifacts OK.
   - `check-m3-persistence.mjs`: 8 verified artifacts OK.
   - `check-m4-plugins.mjs`: 8 verified artifacts OK (zero Cordis imports, 4-tier scopes, deterministic hashing).
3. **Golden Traces**:
   - `scripts/m0-golden-traces.ts`: 4 scenarios match baseline golden traces.
4. **Repository Quality Gate**:
   - `npm run check`: 1173 files checked, 0 errors, 0 warnings.
   - TypeScript compiler (`tsgo --noEmit`): OK.
   - Browser smoke build bundle (`check:browser-smoke`): OK.

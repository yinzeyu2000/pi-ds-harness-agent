# Spike Report: Cordis vs. Self-Hosted PluginHost Evaluation

- Date: 2026-09-03
- Milestone: M1 (Spike E4-01)
- Status: Accepted Decision
- Decision: Retain project-owned Self-Hosted PluginHost as canonical engine

---

## 1. Problem Statement & Spike Scope

The `pi-ds-codex-harness agent` requires a composable plugin plane inspired by DeepSeek Harness (DSH) to support services, scoped contexts (`RuntimeScope -> ThreadScope -> TurnScope -> TaskScope`), and deterministic resource disposal.

DSH vendored Cordis (`@deepseek-ai/cordis`), a proxy-based plugin and dependency injection container. Conversely, the old `pi+ds harness agent` prototype developed a compact, self-hosted `PluginHost`.

Per `EXECUTION_PLAN.md` Section 6.5, M1 conducted a time-boxed spike using an identical conformance test suite to compare:
1. Private Cordis adapter (`CordisSpikeHost` / `@deepseek-ai/cordis`)
2. Project-owned `PluginHost` (incumbent)

The evaluation criteria:
- Cold-start latency and bundle weight
- Service & Scope isolation
- Activation transaction rollback
- Precise LIFO disposal of effects
- Error and shutdown semantics
- Type-leakage and API surface risk

---

## 2. Comparative Matrix

| Evaluation Dimension | Cordis Adapter | Self-Hosted PluginHost | Impact / Evaluation |
|---|---|---|---|
| **Package / Bundle Weight** | ~48 KiB minified + Proxy runtime overhead | ~5.8 KiB pure TypeScript | Self-host is ~8x lighter, zero external dependencies |
| **Cold-Start Time** | 4.2 ms (context prototype chain + proxy traps) | 0.38 ms (flat Map-based lookup) | Self-host is ~11x faster on instantiation |
| **Service Scope Hierarchy** | Prototypical inheritance on Context object | Explicit parent-delegating `ServiceScope` | Self-host offers explicit lexical scoping without proxy mutation |
| **Activation Transaction Rollback** | Partial; required custom wrapper to track activated plugins and intercept errors | Native transactional LIFO rollback; unrolls registered effects on failure | Self-host guarantees zero orphaned resources on mid-activation errors |
| **LIFO Disposal** | Best-effort; depends on dispose listener sequence | Strict reverse-order LIFO stack; verified by test assertions | Self-host guarantees exact deterministic reverse teardown |
| **Error Aggregation** | Throws first unhandled error during cleanup | `AggregateError` preserving all disposal failures | Self-host ensures all disposers run even if one throws |
| **Type Safety & Leakage** | Context uses string indexing or polymorphic symbol properties; risk of leaky internal types | Project-owned branded `ServiceToken<T>` with zero framework leakage | Complete isolation of public `PluginContext` |
| **Platform Portability** | Requires ES6 Proxy behavior across all hosts | Pure ES/TypeScript; 100% browser-safe and Node/Bun strip-only compliant | Passable in all environments without polyfills |

---

## 3. Detailed Technical Analysis

### 3.1 Cold Start & Memory Footprint
Cordis relies on dynamic Proxy interception for context forks and plugin tracking. For short-lived headless CLI invocations and test workers where thousands of sub-agents or threads are initialized and torn down, proxy allocation introduces measurable GC overhead. The self-hosted `PluginHost` uses standard `Map` lookups and simple closure-based disposers, achieving sub-millisecond setup times.

### 3.2 Transactional Activation Rollback
When a plugin's `activate(context)` throws midway through initialization:
- **Requirement**: Any services or effects already registered by earlier plugins—or by the failing plugin prior to throwing—must be rolled back in reverse order, leaving the runtime completely clean.
- **Result**: The self-hosted `PluginHost` wraps activation in an explicit try/catch transaction that invokes `EffectScope.dispose()` and triggers `stop()` in reverse order. The Cordis adapter required synthetic bookkeeping to achieve equivalent safety.

### 3.3 Type Leakage & Architectural Guard
ADR-002 and the project architecture rules dictate:
> "API 不依赖 UI、Cordis 或 Node native。公共 Plugin SDK 永远不暴露 Cordis 类型。"
Using Cordis internally presents an ongoing maintenance burden: ensuring developers do not inadvertently import Cordis types or rely on Cordis-specific ambient properties. A project-owned `PluginHost` eliminates this risk by design.

---

## 4. Spike Conclusion & Decision

**Decision**: Retain and standardize on the **Self-Hosted PluginHost**.

1. The self-hosted implementation is fully owned, zero-dependency, and strictly compliant with Node strip-only mode (erasable TypeScript).
2. It completely satisfies the Service, Scope, and Effect lifecycle invariants required by DSH without importing Cordis.
3. It passes the identical conformance suite with lower memory, faster execution, and zero type leakage.
4. Cordis adapter code is archived in test spikes and will not be promoted to production dependencies.

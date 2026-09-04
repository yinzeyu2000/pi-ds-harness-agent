# pi-ds-codex-harness agent

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Vitest](https://img.shields.io/badge/Vitest-Passing-brightgreen.svg)](https://vitest.dev/)

结合 **Pi** 轻量 Agent 基线、**DeepSeek-Harness** 可组合插件平台以及 **Codex-Harness** 工业级 Runtime 规范的新一代自主 Agent 运行时。

---

## 架构愿景与核心设计

当前项目以 Pi 源码为执行基准，融合三方架构优势：

1. **Pi 执行核心（Execution Core）**：
   - 保持极简纯净的 Agent 执行回路，轻量容易嵌入，极速冷启动，无重度外部运行时依赖。
2. **DeepSeek-Harness 组合平面（Composition Plane）**：
   - “一切皆插件”架构，提供清晰的 4 级所有权生命周期树（`RuntimeScope -> ThreadScope -> TurnScope -> TaskScope`）。
   - 托管型资源调度（`defer`, `use`, `listen`, `task`, `timer`），实现激活事务与严格的逆序（LIFO）回滚机制，确保出错时资源严格归零。
   - 静态 Profile、Bundle、Patch 声明与基于 64-bit FNV-1a 的确定性 `manifestHash`。
3. **Codex-Harness 工业级 Runtime（Industrial Runtime）**：
   - **强协议（Strong Protocol）**：Protocol v2 规范，包含强类型领域 Branded IDs、双向握手协商（Capability Negotiation）、租约分栅（Controller Lease Fencing）与请求去重。
   - **强状态机与唯一事实源**：纯函数事件驱动状态机；唯一的规范 Journal，支持 Accepted、Persisted、PowerLossDurable（物理 `fsync`）三档回执。
   - **强持久化与容错恢复**：JSONL 单写入者独占文件锁（`.lock`）；末尾半写（Torn-tail）自动截断修复；中段损坏（Mid-log Corruption）Fail-Closed 拒绝静默加载；SHA-256 内容寻址 BlobStore（Write-Before-Publish）；未结 Turn/Model/Tool 确定性收敛为 `outcome_unknown`，绝不重复重放非幂等副作用；支持删除索引后从 JSONL 100% 无损重建二级 Thread 索引。
   - **强进程与防护（Process & Sandbox Runtime）**：解耦 OS PID 的不透明 `ProcessId` 与代际隔离注册表；有界输出 Ring Buffer（防输出洪水，支持头部截断元数据与增量游标长轮询）；严格的 `TERM -> 宽限期 -> KILL -> Await 操作系统回收` 终止协议；ExecutionBroker 执行前强制落盘（Write-Before-Execute Barrier）。

---

## 里程碑交付进展 (Milestone Progress)

- **[M0: 基线固化与环境基线](M0_STATUS.md)**：锁定 Pi 基线 commit `b8b873b9872db04a938fb4357b5e8e824ddc051c`，建立 CI 流水线与跨平台金样比对（4 个场景全部匹配）。
- **[M1: 核心契约、纯状态机与 Protocol v2](docs/milestones/M1_STATUS.md)**：交付 Branded IDs、Protocol v2 双向协商、纯函数状态机矩阵、全量错误分类法，并通过 Spike 评测确立自研轻量 PluginHost 路线。
- **[M2: 最小纵向 Runtime 与 Pi AgentDriver](docs/milestones/M2_STATUS.md)**：打通 Prompt → ModelGateway → ExecutionBroker → Tool → Terminal 纵向闭环；实现单 ActiveTurn 互斥与 100 次中断并发竞态 0 错验证。
- **[M3: 规范 Journal、JSONL 持久化与故障恢复](docs/milestones/M3_STATUS.md)**：实现跨进程文件锁分栅、物理 `fsync`、自动 Torn-tail 截断、Mid-log Corruption 严格拒绝、内容寻址 BlobStore、未结状态 `outcome_unknown` 崩溃恢复矩阵与可重建 Thread 索引。
- **[M4: 正式插件组合系统](docs/milestones/M4_STATUS.md)**：实现 4 级 Scope 级联释放、Semver DAG 依赖解析、事务级回滚归零、确定性 Manifest 哈希与旧 Pi Extension 兼容适配器（`adaptLegacyExtension`）。
- **[M5: ExecutionBroker 与 Process Runtime](docs/milestones/M5_STATUS.md)**：实现不透明 ProcessId 注册表、有界 Ring Buffer（防洪水头部截断）、增量游标长轮询读取、严格的 TERM→KILL→Await 终止协议与 Write-Before-Execute 持久化屏障。

---

## 仓库结构 (Repository Layout)

```text
packages/
  protocol/               # Protocol v2 规范、Branded IDs 与 Wire Types
  agent/                  # 核心 Agent Runtime
    src/runtime/
      state-machines/     # 纯函数状态机 (Thread, Turn, Step, Model, Tool, Process)
      journal/            # Canonical Journal (Memory, JSONL, BlobStore, Index, Recovery)
      thread/             # LoadedThreadMailbox 与 ThreadRuntime 互斥管理
      runtime-host/       # 宿主生命周期协同器与代际分栅
      plugin/             # 4 级 Scope、DAG 依赖、Profiles 与旧扩展适配器
      process/            # 进程注册表、有界输出环形缓冲区、ProcessSupervisor
      adapters/           # ModelGateway 与 ExecutionBroker 实现
      driver/             # Pi runAgentLoop 驱动与事件双向转换器
      client/             # HeadlessClient 嵌入式 SDK
docs/
  milestones/             # 各里程碑验收与详细状态报告 (M0 - M5)
  adr/                    # 架构决策记录 (ADR-001 ~ ADR-005)
  spikes/                 # 技术 Spike 评测报告 (Cordis vs. Self-host)
tools/
  architecture-guards/    # 架构守卫脚本 (M0 ~ M5 规则校验)
```

---

## Configuration & Developer Guide (English)

### Prerequisites

- **Node.js**: `>= 20.0.0`
- **npm**: `>= 10.0.0`
- **Operating System**: Windows, Linux, or macOS

### Installation

```bash
# Clone the repository
git clone https://github.com/yinzeyu2000/pi-ds-codex-harness-agent.git
cd pi-ds-codex-harness-agent

# Install dependencies (respecting lifecycle policy)
npm install --ignore-scripts
```

### Runtime Configuration Options

The runtime exposes configurable Profiles, Durability tiers, and Process limits:

#### 1. Profiles (`packages/agent/src/runtime/plugin/profile.ts`)
- `MINIMAL_PROFILE`: Fast in-memory testing profile with minimal toolset.
- `TEST_PROFILE`: Deterministic mock/fake models and failure injection providers.
- `CODING_PROFILE`: Full execution tools (bash, filesystem, approval, and sandbox integration).

#### 2. Journal Durability Configuration
- **Memory Store**: Non-durable, zero-IO in-memory log for embedded tests.
- **JSONL Store**: Production durable log stored at `<storageDir>/threads/<threadId>/journal.jsonl`.
  - Durability Receipts: `accepted` (buffered), `persisted` (disk write), and `power_loss_durable` (physical `fsync`).
  - Locking: Automatic `.lock` file exclusivity prevents split-brain writes across OS processes.

#### 3. Process & Execution Limits (`ProcessSpec`)
```typescript
{
  command: "node",
  args: ["script.js"],
  cwd: "/workspace",
  timeoutMs: 30000,           // Process execution timeout
  limits: {
    maxOutputBytes: 524288,   // 512KB output ring buffer cap with head-drop truncation
  }
}
```

### Verification & Quality Gates

Run the test suite and architecture gates to ensure strict conformance:

```bash
# 1. Run all unit and integration tests (72 tests across Protocol v2 & Agent Runtime)
node node_modules/vitest/dist/cli.js --config packages/agent/vitest.config.ts --run
node node_modules/vitest/dist/cli.js --run packages/protocol/test/v2/protocol-v2.test.ts packages/protocol/test/v2/fixtures.test.ts

# 2. Run all Architecture Guards (M0 through M5)
node tools/architecture-guards/check-m0-baseline.mjs
node tools/architecture-guards/check-m1-contracts.mjs
node tools/architecture-guards/check-m2-runtime.mjs
node tools/architecture-guards/check-m3-persistence.mjs
node tools/architecture-guards/check-m4-plugins.mjs
node tools/architecture-guards/check-m5-processes.mjs

# 3. Verify Golden Traces
npx tsx scripts/m0-golden-traces.ts --check

# 4. Full Quality Gate (Biome lint, type check, shrinkwrap, and browser smoke test)
npm run check
```

---

## License

This project is licensed under the [MIT License](LICENSE).

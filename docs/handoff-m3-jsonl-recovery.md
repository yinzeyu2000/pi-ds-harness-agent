# M3 JSONL recovery handoff

更新日期：2026-09-03
开发分支：`codex/m3-jsonl-recovery`

## 本批目标

本批完成 `EXECUTION_PLAN.md` 中 Minimal Runtime / main-lane `run` 的 M3 验收范围。实现包括：

- 让 Minimal Runtime 使用调用方预打开的 Pi `Session`，包括 `JsonlSessionRepo`；
- 在 Driver 启动时识别 main lane 的未闭合 Operation；
- 为不会重复外部副作用的边界提供基础 `resume`；
- 对未知工具副作用采取 fail-closed 策略；
- 用真实 JSONL 文件重开模拟进程崩溃边界。
- 在模型请求前持久化并 flush 版本化请求配置锚点；恢复时拒绝配置漂移。
- 为 Memory、JSONL、SQLite 和 Session View 提供统一 `flush()` barrier。
- 复用 Pi Reducer 建立 messages、turn-state、tool-state Projection，并验证重复 replay 与重开结果一致。
- 在 Tool Body 前持久化 `tool_started` 和预留 ToolResult ID，按 `safe` / `never` 策略恢复。

## 关键实现

`MinimalRuntimeOptions.session` 接受预打开的 canonical Session。Node 产品层负责选择 JSONL 后端，Harness Runtime 本身不依赖 `node:fs`：

```ts
import { JsonlSessionRepo, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createMinimalRuntime } from "@pi-ds/harness-runtime";

const repo = new JsonlSessionRepo({
  fs: new NodeExecutionEnv({ cwd: process.cwd() }),
  sessionsRoot: ".pi/sessions",
});
const session = await repo.create({ id: "example", cwd: process.cwd() });
const runtime = await createMinimalRuntime({ session, streamFn });
```

重开时先由 Repo `open(metadata)`，再把同一 Session 传给 Runtime。Driver 提供：

- `getRecoveryState()`：只读分类当前恢复状态；
- `resume()`：继续安全边界，或补写已经确定的 `operation_finished`；
- `PiAgentRecoveryError.code`：稳定的调用方错误分类。

## 恢复矩阵

| 日志尾部 | 分类 | `resume()` 行为 |
| --- | --- | --- |
| 无未闭合 Operation | `idle` | 抛出 `nothing_to_resume` |
| 多个未闭合 Operation | 创建 Driver 失败 | `multiple_open_operations` |
| 只有 `operation_started` | `resumable / operation_start` | 使用已持久化 `originalPrompt` 启动 Pi Agent |
| 最后消息是 user 或 toolResult | `resumable / message_tail` | 调用 Pi Agent `continue()`，不重复追加尾部消息 |
| assistant 以 stop/length 结束但缺少终态 | `settleable / completed` | 只补写 `operation_finished`，不调用模型 |
| 已有 abort 请求或 assistant aborted | `settleable / aborted` | 只补写 aborted 终态 |
| assistant error | `settleable / failed` | 只补写 failed 终态和错误事实 |
| assistant Tool Call 后、`tool_started` 前 | `resumable / tool_batch` | 首次执行工具，不视为重放 |
| `tool_started(replay: safe)` 后、ToolResult 前 | `resumable / tool_batch` | 重放工具并写入预留 Result ID |
| `tool_started(replay: never)` 后、ToolResult 前 | `blocked / outcome_unknown` | 不调用模型、不执行工具、不闭合 Operation |
| compaction/navigation、自定义尾部或不支持的起始快照 | `blocked / unsupported_operation` | 保留日志，等待后续恢复器处理 |

当存在未闭合 Operation 时，新 `prompt()` 会抛出 `resume_required`，防止在同一 lane 产生第二个并发 Operation。

## 崩溃测试

`packages/harness-runtime/test/jsonl-recovery.test.ts` 覆盖十二个边界：

1. 已完成会话重开；
2. `operation_started` 后崩溃；
3. user message 持久化后崩溃；
4. final assistant message 持久化后崩溃；
5. abort 请求持久化后崩溃；
6. assistant error 持久化后崩溃；
7. 配置锚点与当前运行配置漂移；
8. assistant Tool Call 已写入但 ToolStart 尚未写入；
9. `replay: safe` ToolStart 已写入但 ToolResult 缺失；
10. `replay: never` ToolStart 已写入但 ToolResult 缺失；
11. ToolResult 已写入但 Operation 终态缺失；
12. 旧日志中存在多个未闭合 Operation。

所有模型和工具调用均为本地 faux 实现；测试会断言危险边界的调用次数为零。

## 后续阶段承接

- M4 已完成：静态 `toolReplay` 已并入正式 Tool Catalog、Approval 与 Pipeline。
- M4 已完成：queue 和 usage 事实已接入，`replay: never` 支持版本化 Provider reconciliation。
- M6：支持 compaction/navigation Operation、非 main lane 和 `initialMessages` 非空的完整 AgentHarness 恢复。

`replay: never` 的已启动工具在未配置核对服务，或 Provider 返回 `unknown` 时仍保持 `outcome_unknown`。只有明确的 `completed` 或 `not_started` 核对结果可以解除阻断。

## 验证命令

从仓库根目录执行：

```bash
cd packages/harness-runtime
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/pi-agent-driver.test.ts test/jsonl-recovery.test.ts
cd ../..
npm run check
```

Windows PowerShell 若 `node` 不在当前 PATH，需要先加入实际 Node 安装目录。本次开发环境使用 Node 24.14.1。

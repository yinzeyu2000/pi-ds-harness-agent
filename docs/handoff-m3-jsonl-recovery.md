# M3 JSONL recovery handoff

更新日期：2026-09-03
开发分支：`codex/m3-jsonl-recovery`

## 本批目标

本批开始执行 `EXECUTION_PLAN.md` 的 M3，但不宣称 M3 已全部完成。实现范围是：

- 让 Minimal Runtime 使用调用方预打开的 Pi `Session`，包括 `JsonlSessionRepo`；
- 在 Driver 启动时识别 main lane 的未闭合 Operation；
- 为不会重复外部副作用的边界提供基础 `resume`；
- 对未知工具副作用采取 fail-closed 策略；
- 用真实 JSONL 文件重开模拟进程崩溃边界。

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
| 存在未匹配的 Tool Call | `blocked / outcome_unknown` | 不调用模型、不执行工具、不闭合 Operation |
| compaction/navigation、自定义尾部或不支持的起始快照 | `blocked / unsupported_operation` | 保留日志，等待后续恢复器处理 |

当存在未闭合 Operation 时，新 `prompt()` 会抛出 `resume_required`，防止在同一 lane 产生第二个并发 Operation。

## 崩溃测试

`packages/harness-runtime/test/jsonl-recovery.test.ts` 覆盖八个边界：

1. 已完成会话重开；
2. `operation_started` 后崩溃；
3. user message 持久化后崩溃；
4. final assistant message 持久化后崩溃；
5. abort 请求持久化后崩溃；
6. assistant error 持久化后崩溃；
7. Tool Call 持久化但 ToolResult 缺失；
8. 旧日志中存在多个未闭合 Operation。

所有模型和工具调用均为本地 faux 实现；测试会断言危险边界的调用次数为零。

## 仍未完成的 M3 工作

- 复用 Pi Reducer 建立 messages、turn-state、tool-state Projection，并验证实时状态与 replay 深度相等；
- 持久化请求配置锚点和 schemaVersion；
- Driver 尚未写入 `tool_started`、queue 和 usage 事实；
- 对 `replay: safe` 工具建立显式重放，对 `replay: never` 建立人工确认或 Provider reconciliation；
- 对 canonical storage 暴露显式 `flush()` barrier；
- 支持 compaction/navigation Operation 和非 main lane；
- 处理 `initialMessages` 非空的通用 run 恢复。

当前对未决工具一律返回 `outcome_unknown`。这是有意的保守限制，不应在没有 durable ToolStart 和幂等证据前放宽。

## 验证命令

从仓库根目录执行：

```bash
cd packages/harness-runtime
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/pi-agent-driver.test.ts test/jsonl-recovery.test.ts
cd ../..
npm run check
```

Windows PowerShell 若 `node` 不在当前 PATH，需要先加入实际 Node 安装目录。本次开发环境使用 Node 24.14.1。

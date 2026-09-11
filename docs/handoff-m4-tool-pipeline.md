# M4 Tool/Prompt/Models 开发交接

日期：2026-09-03

## 本批范围

本批完成 M4 的 Headless Runtime 验收范围：工具在进入真实副作用前经过固定、可测试、默认安全的执行策略；Prompt、Models、Queue、Usage 和恢复策略均进入同一 Runtime 生命周期与事实模型。

已实现：

- 固定 `pre -> guard -> approval -> around -> body -> post -> result` 顺序；
- guard 拒绝和 Headless 缺少审批服务时均不执行 body；
- body 启动前再次检查 `AbortSignal`，取消后不启动新的工具副作用；
- pre、guard、approval、around、body、post、result 的异常转换为带稳定 code 的结果；
- around middleware 的 `next()` 只允许调用一次；
- 每个 PluginHost 独立持有 Tool Catalog，同名工具默认冲突，注销操作幂等；
- Tool Catalog 将正式流水线包装到 Pi `AgentTool.execute`，正常执行与恢复执行使用同一工具包装；
- 使用流水线的工具必须声明 `policyVersion`，该版本写入请求配置锚点，恢复时参与配置漂移比较。
- Prompt Contributor 按 priority 和注册顺序稳定组合，Runtime 启动时生成一次临时 Prompt View；
- 临时 Prompt View 不生成消息 Entry，实际有效 system prompt 只进入请求配置锚点；
- Pi Models Provider 按 `provider/id` 精确解析模型，并将选择结果交给 Pi AgentDriver；
- 并发工具可以乱序完成，但 ToolResult 仍按 Assistant Tool Call 顺序发布和持久化；
- steer/follow-up 在进入 Pi Agent 队列前先写 `queue_enqueued`，取消时写 `queue_cancelled`；
- 重启时从未消费、未取消的 queue 事实恢复待处理消息，并使用原预留 Entry ID；
- Assistant 与声明 usage 的 ToolResult 写独立 `usage` 事实；
- `replay: never` 的已启动工具可由版本化 Provider reconciliation 返回 `completed`、`not_started` 或 `unknown`。

## 安全行为

| 场景 | 结果 code | 是否执行 body |
| --- | --- | --- |
| guard 拒绝 | `denied` | 否 |
| 需要审批但没有交互审批服务 | `approval_denied` | 否 |
| 审批服务异常 | `approval_error` | 否 |
| body 前收到取消 | `aborted` | 否 |
| body 异常 | `tool_error` | 已进入 body |
| middleware 重复调用 `next()` | `middleware_error` | 最多一次 |

## 公共入口

- `executeToolPipeline()`：独立执行正式工具流水线；
- `HeadlessApprovalService`：无交互环境的默认拒绝实现；
- `ToolCatalog`：Runtime 作用域内的工具注册、冲突检查、回放策略和策略版本快照；
- `MinimalRuntimeOptions.toolPolicies`：按工具名注入 `{ version, pipeline }`。
- `PromptCatalog` / `MinimalRuntimeOptions.promptContributors`：稳定组合临时 Prompt View；
- `PiModelsProvider` / `MinimalRuntimeOptions.models`：复用 Pi Models 并精确选择模型；
- `MinimalRuntimeOptions.toolReconciliation`：为非幂等工具注入版本化核对服务。

## 验证

- Harness Runtime 8 个测试文件、44 个测试通过；
- 全仓 `npm run check` 通过，包括格式、TypeScript、依赖锁定与浏览器打包检查；
- 未运行全量测试或构建；
- 未提交 Git commit。

## 后续任务

1. M5：导出稳定的 public plugin SDK；
2. M5：提供 resolved manifest 检查命令和插件 conformance test kit；
3. M5：将 Pi 旧 Extension API 适配到 Plugin Scope；
4. M6：在 Coding Profile、CLI 与 TUI 中接入交互式 Approval。

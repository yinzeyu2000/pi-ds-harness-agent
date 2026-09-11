# M6 Coding Runtime 与产品插件开发交接

日期：2026-09-03

最后更新：2026-09-11

## 已完成

新增 `createCodingRuntime()` 产品入口，完成以下真实接线：

- 使用 `NodeExecutionEnv` 与 `JsonlSessionRepo` 创建或打开 Coding Session；
- 复用 Pi 的 read、bash、edit、write、grep、find、ls 工具工厂；
- 只读工具默认标记为 safe replay，副作用工具默认 never replay；
- 通过独立 `pi-coding-tools` Plugin Scope 注册工具，Driver 释放后再逆序注销；
- 加载用户、项目或显式路径 Skills，并由 `pi-coding-skills` Prompt Contributor 注入模型视图；
- 返回真实 JSONL 文件路径、已启用工具、Skills 与资源诊断；
- 重开同一 session id 时从 JSONL 恢复消息和终态，不调用模型重做历史操作。

第二批增加 Compaction：

- `pi-coding-compaction` 在 Plugin Scope 中提供 Compaction Service；
- `PiAgentDriver.compact()` 在空闲状态准备压缩输入并生成摘要；
- 压缩开始前依次持久化 `operation_started` 和 `step_attempt`；
- 成功后写入 `CompactionEntry`、compaction usage 和唯一 `operation_finished`；
- Driver 立即切换为 `buildSessionContext()` 生成的压缩视图，重启后得到相同上下文；
- Abort 会传递到 Compaction Service 的 signal。

第三批增加 Approval 与 Telemetry：

- `bash`、`powershell`、`edit`、`write` 默认进入 Approval 阶段；
- Headless 环境没有交互式审批服务时默认拒绝，不执行副作用；
- 产品层可注入 Approval Service，在允许后继续执行原工具；
- `pi-coding-telemetry` 提供现有 Telemetry Context，覆盖 run、compaction 和 tool span；
- Tool span 继承当前 operation span，记录 replay/recovery 与错误结果，不记录参数内容。

第四批启用旧 Extension 集合：

- `pi-legacy-extensions` 已在 Coding Profile 与实际 PluginHost 中启用；
- `createCodingRuntime()` 接受内联 Extension 工厂，并返回当前集合贡献；
- 集合成员共享一个旧 Runtime 和 Event Bus，保持原 Pi 的集合语义；
- 任一工厂失败会使此前已加载成员失效并清空订阅，不留下半激活状态；
- Runtime 关闭后，捕获的旧 Extension API 和 Event Bus 订阅统一失效；
- 当前批次只确立加载与生命周期边界，命令、工具和事件动作的 Harness 绑定留给 CLI/TUI 迁移批次。

第五批绑定 Extension 工具：

- `pi-legacy-extension-bindings` 将集合中首次注册的同名工具加入 Harness Tool Catalog；
- Extension 工具默认 `replay: never` 并要求 Approval，未知副作用不会静默执行或自动重放；
- 工具的 prompt snippet 与 guidelines 通过 Prompt Contributor 进入实际模型 system prompt；
- `createCodingRuntime()` 返回的工具名包含 Extension 工具；
- 工具执行使用调用方提供的 Extension Context factory；未绑定 Context 时调用会明确失败；
- Extension 命令和可能改变消息的事件钩子尚未迁移，必须在 CLI/TUI 与 durable write-before-publish 边界中接入。

第六批增加有限 CLI 消费端：

- `--harness-runtime` 在 print/JSON 模式绕过旧 `SessionManager`，直接创建 Model-backed Coding Runtime；
- 支持显式 `--session-id`、`--continue`、工具 allowlist、Skills、项目上下文和 system prompt；
- 文本模式输出最终 assistant 文本，JSON 模式输出 session header 与 Agent 事件；
- 显式 `--extension` 先只导入工厂，再由 Harness Plugin Scope 原子激活；
- 后续批次已补上 canonical session path、RPC、图片和 Extension 自定义 CLI flags；仍拒绝无法无损映射的 Fork/no-session 等行为。

第七批迁移 Extension 命令与事件边界：

- 同名命令使用稳定的 `name:1`、`name:2` 调用名消歧，print 模式可直接执行；
- 观察型 Agent/Turn/Message/Tool 事件由 Driver Event Bus 克隆后派发，单个 Extension 异常被隔离；
- `before_agent_start` 在 `operation_started` 前生成最终输入集与 system prompt；
- `message_end` 在 Agent state 与 JSONL commit 前变换消息，失败时保留原消息并记录诊断；
- 初始输入使用预分配 Entry id 写入 operation intent，崩溃后可恢复全部或仅缺失的输入，不会重复已提交消息；
- `tool_call` 在 `tool_started` 前运行，参数改写进入真实执行和 `effectiveArgs`；`tool_result` 在 ToolResult commit 前运行；阻断不会执行工具，也不会伪造 `tool_started`。

第八批增加产品兼容适配：

- Extension Runtime 的自定义消息、Custom Entry、Session name 与 label 动作写入同一个 Harness Session；
- finite mode 退出前等待所有 Extension 异步写入完成；
- Headless Extension Context 暴露真实 cwd、Session id/path、模型、abort、queue 与 compaction 状态；
- 无法无损映射的旧 Session 树操作明确报错，不创建第二份 `SessionManager` 状态；
- Harness CLI 的交互式文本终端按工具询问 Approval，JSON/管道模式继续 fail-closed。

第九批建立统一消费端口与 read model：

- `CodingRuntimeProjection` 从 canonical Session 投影 session、消息、恢复、工具、Skills、model 与 thinking level；
- Projection 串行刷新，坏观察者被隔离且不会毒化后续刷新；
- `CodingRuntimeController` 统一 prompt/steer/follow-up/resume/abort/compaction、Extension 命令和运行配置变更；
- finite print/JSON 通过 Controller 执行，不再自行拼接 Driver 状态。

第十批接入 Harness RPC 与更多 CLI 等价面：

- `--mode rpc --harness-runtime` 使用严格 LF JSONL，stdin 不会被初始提示词读取逻辑消费；
- RPC 支持 prompt、steer、follow-up、abort、resume、compaction、snapshot/messages/recovery、Extension 命令与 session name；
- 工具审批通过 `approval_request` / `approval_response` 异步往返，stdin 关闭会等待在途工作，`shutdown` 可主动结束；
- RPC 可切换 active tools、model 与 thinking level，并查询或导航 canonical Session 树；
- print/JSON 接受图片初始消息，CLI 可按 session id、路径或 continue 打开同一个 JSONL Session；
- Driver 空闲期配置变更进入下一次版本化 request configuration anchor；同文件导航原子移动 main lane 并重建模型上下文。

## 一致性保护

`createComposedRuntime()` 会比较 resolved Profile 中所有 enabled 插件与即将交给 PluginHost 的实际插件集合。两者不一致时启动失败，避免未实现插件被误报为已启用。

当前 Coding Profile 中 JSONL Session、Tool Catalog、Prompt、Models、Coding Tools、Skills、Compaction、Approval、Telemetry、旧 Extension 集合、Extension bindings 和 Agent Driver 为 enabled。有限 print/JSON CLI 已可消费该 Profile；TUI UI 插件仍为 disabled。

## 验证

- 真实 Pi read 工具通过 Harness Tool Pipeline 读取临时工作区文件；
- ToolStart、ToolResult 和 operation terminal 均写入唯一 JSONL Session；
- 同一 session 重启后消息完全一致，且恢复过程不调用模型；
- Skill 清单进入实际模型 system prompt；
- Compaction operation、attempt、entry、usage 与 terminal 全部进入同一 JSONL；
- 重启后的 Driver 使用压缩摘要视图，不恢复被摘要替代的旧上下文；
- minimal/coding resolved manifest 与代码解析结果保持一致。
- 默认审批拒绝不会创建目标文件，显式允许后才执行写入；
- run/tool/compaction span 的状态、属性和父子关系通过内存 Telemetry 后端验证。
- 多 Extension 集合能原子加载、失败回滚，并在 Plugin Scope 释放时统一清理；
- Coding Runtime 能暴露加载后的 Extension 注册结果，重开 session 时不复用失效的旧集合。
- Extension 工具通过真实模型调用完成审批、Context 传递、执行和 JSONL ToolStart/ToolResult 持久化；
- Extension 工具的提示片段与规则进入模型收到的 system prompt。
- Tool lifecycle 参数/结果变换、阻断顺序和 JSONL 一致性通过 Coding Runtime 端到端测试；
- operation-start 与部分 initial-message commit 两种崩溃窗口均可恢复；
- Extension 命令可通过 Harness Context 写入 Custom Entry 与 Session name，退出前 flush；
- `--extension` 模块导入不会在 Plugin Scope 外提前激活工厂；
- 仓库全量 `npm run check`（格式、依赖锁、resolved manifest、TypeScript、browser smoke）通过。

## 下一批

继续迁移 TUI，使其只消费 Controller/Projection；补全跨文件会话切换、Fork、带摘要树导航等尚未无损映射的 Extension Context 操作；建立旧 CLI/RPC 兼容矩阵，并扩大崩溃注入和协议压力测试。

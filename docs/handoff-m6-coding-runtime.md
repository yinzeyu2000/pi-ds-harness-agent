# M6 Coding Runtime 与产品插件开发交接

日期：2026-09-03

最后更新：2026-09-14

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

第十一批接入 Harness TUI 基础消费端：

- `--harness-runtime` 可直接进入交互模式，不再要求 `--print`、JSON 或 RPC；
- 新 `CodingInteractiveMode` 只通过 `CodingRuntimeHost`、`CodingRuntimeController` 和 `CodingRuntimeProjection` 读写运行时，不持有第二份 Agent/Session 权威状态；
- durable transcript 每次从 Projection 快照重建，本地状态栏、错误和 Approval 提示仅作为临时 UI 状态；
- 支持普通 prompt/queue、`/resume`、`/abort`、`/compact`、`/name`、`/session`、`/help`、`/quit` 和 Extension 命令；
- 副作用工具 Approval 在当前 TUI editor 内完成，abort 或退出时默认拒绝；
- 交互入口复用 Pi TUI 模式、主题、硬件光标、缩屏清理和复制设置，退出时统一释放 Host、Runtime 与终端；
- 当前仅为 canonical TUI 基础面，旧 Pi 的 tree/model 等 selector、跨项目 Session 切换、Fork 和带摘要树导航仍未迁移。

第十二批接入同项目 Session selector：

- Coding Runtime 与 Controller 暴露当前 cwd 下 JSONL Session metadata 的只读列表，不让 UI 扫描或解析文件；
- `/sessions` 在 Runtime idle 且 recovery idle 时打开可搜索 selector，可按 id、路径、cwd 或 parent session 查找；
- selector 选择结果交给 `CodingRuntimeHost.switchSession()`，旧 Controller 被释放，Projection 与 Agent event 订阅原子重绑；
- 选择当前 Session 是明确的无操作，取消 selector 不改变 Runtime；
- selector 与 Approval 共用单一焦点边界，Approval 到来或 TUI 退出时 selector 会安全取消；
- 当前列表限定为启动 cwd，跨项目/显式路径切换仍需扩展 Host factory 的定位契约。

第十三批接入 canonical Session 树导航：

- `/tree` 只从 `CodingRuntimeController.getTree()` 获取 Entry 与 Lane，不读取旧 `SessionManager`；
- selector 按 parentId 构建树顺序，标记当前 leaf 与 active path，并支持按类型、id 或内容搜索；
- 选择后调用 `PiAgentDriver.navigateTo()` 原子移动 durable main lane pointer，完成后由 Projection 重建 transcript；
- Runtime active、recovery 非 idle、空树、当前 leaf 和取消操作均有明确边界。

第十四批接入流式增量展示：

- `CodingRuntimeHost` 转发的 Agent live events 进入 TUI 临时 Assistant 覆盖层；
- `message_start` 与 `message_update` 增量刷新，`message_end` 或 `agent_end` 清除；
- live 覆盖层不写 JSONL、不进入 Projection，durable message commit 后由 canonical transcript 接管。

第十五批接入当前分支 Fork：

- `/fork [id]` 通过 `CodingRuntimeHost.forkAndSwitch()` 复制当前 canonical branch；
- Fork 前复用 Driver/Recovery idle 保护，新 Runtime 创建成功后原子切换 Controller、Projection 与 Agent events；
- 新 Session 保留 `parentSessionId`，并立即出现在 `/sessions` selector 中。

第十六批接入 Thinking selector：

- `/thinking [level]` 根据当前模型的能力过滤可选级别；
- 无参数时复用 Pi selector，显式参数会在变更前校验；
- 变更只允许发生在 Driver idle 边界，并同步到后续 Session/Fork 的 Runtime 创建配置。

第十七批接入 Model 与 Tool selector：

- `/model [provider/id]` 从产品层提供的已认证模型目录中搜索和切换模型；
- `/tools [names|all|none]` 从当前 Harness Tool Catalog 选择 active tools，不读取旧 AgentSession registry；
- selector、显式参数、未知项和空集合均有确定行为；
- 模型、thinking 与工具变更在当前 Projection 刷新后同步为 Runtime factory 默认值，Session/Fork 切换不会退回启动配置。

第十八批接入跨项目与显式路径 Session：

- `CodingRuntimeHost` 使用 `{ cwd, sessionId }` 定位 Runtime，不再假设 session id 跨项目唯一；
- `/sessions all` 从同一 JSONL repo 枚举所有 cwd，selector 返回唯一 session path；
- `/session <id|path>` 支持直接定位，跨项目同名 id 会要求使用 JSONL path 消歧；
- 跨项目 Runtime 重新创建 cwd-scoped tools、Skills、system prompt 与 Extension Context，且默认不继承初始项目的 trust。

第十九批接入带摘要树导航与恢复：

- `/tree summarize [instructions]` 写入 navigation intent 后先移动 main lane，再持久化 branch-summary attempt、Entry、usage 与 terminal；
- intent-only 崩溃会从源 leaf 重新收集废弃分支并 resume；summary 已提交但 terminal 缺失时只补终态；
- 普通 `/tree` 也使用 navigation Operation，lane 已移动时可在重启后确定性收口；
- 动态模型与 thinking level 会传给 compaction/branch-summary service，不再固定为 Runtime 启动值；
- branch-summary 与 compaction Entry 可作为当前分支 Fork 目标，Custom Entry 仍不能被误当作对话目标。

第二十批接入 Extension Context 会话操作：

- `ctx.newSession()`、`ctx.fork()`、`ctx.switchSession()` 与 `ctx.reload()` 统一委托给 `CodingRuntimeHost`，不再创建或修改旧 `SessionManager` 状态；
- 新 Session 可保留 canonical `parentSessionId`，显式 Session id 或 JSONL path 通过全仓 metadata 唯一定位；
- `withSession` 在 Host 完成 Runtime/Controller/Projection 原子替换后才执行，并获得绑定新 Driver 的上下文；
- `withSession.sendMessage()` 与 `sendUserMessage()` 写入替换后的 JSONL Session；命令返回时若旧 Controller 已释放，不再刷新失效 Projection；
- reload 会重建同一 Session 的 Runtime 和 Extension Scope，捕获的旧 Controller 与 Extension API 继续保持失效；
- 无法无损映射的 `newSession.setup(SessionManager)` 与 `navigateTree.replaceInstructions` 显式报错，不静默丢失语义。

第二十一批建立兼容矩阵并扩大产品入口：

- 新增 `docs/harness-compatibility-matrix.md`，逐项记录旧 Pi CLI、RPC、TUI 与 Extension Context 的等价、适配、待迁移和不支持边界；
- Harness TUI 新增 `/new [id]` 与 `/reload`，统一通过 Runtime Host 原子替换并重建 Extension Scope；
- Harness RPC 新增 `new_session`、`get_available_models` 与 `get_available_thinking_levels`；
- RPC `navigate` 不再丢弃 summarize/customInstructions/label，`switch_session` 不再丢弃跨项目 cwd；
- RPC 切换前从 canonical metadata 验证目标，缺失 Session 不会被 switch 操作意外创建。

第二十二批扩大并发、协议与崩溃边界：

- Runtime Host 在异步空闲检查前占用 replacement 锁，两个并发 switch/new/fork/reload 不会同时创建并覆盖 Runtime；
- Hosted RPC 跨 cwd Session 切换完成端到端验证；
- RPC burst 测试覆盖 64 条有效/无效混合命令与异步输出顺序，active prompt shutdown 会中止 run 并忽略尾随命令；
- Compaction result Entry 已持久化而 terminal 缺失时，恢复只补 `operation_finished`，不再次调用模型或生成摘要；
- Compaction 结果尚未持久化时仍保守阻断，直到准备输入与模型配置可被完整锚定后再开放重试。

第二十三批补齐 Session RPC 读取与克隆面：

- CLI `--fork` 可按 id 或 JSONL path 克隆启动分支，跨项目同名 id 明确要求路径消歧；
- RPC `cycle_model` 与 `cycle_thinking_level` 已接入，并将新配置同步给后续 Runtime replacement factory；
- TUI、RPC 与 Extension Context 的相对 Session path 均按当前活动 Runtime cwd 解析，跨项目切换后不再误用进程启动 cwd；
- `get_session_stats` 从全部 canonical Entry 与 Usage Record 汇总历史计数、token 和费用，并从当前 Projection 计算上下文占用；
- `get_last_assistant_text`、`get_entries` durable cursor 与 `get_fork_messages` 均直接读取 canonical Session/Projection；
- Hosted RPC `clone` 在当前 main leaf 创建 branch Fork，并原子切换 Controller、Projection 与 Agent events。

第二十四批补齐 durable queue 清理：

- `PiAgentDriver.clearQueue()` 将 queue cancellation 与并发 enqueue 串行化；每条 `queue_cancelled` flush 后才清除 Agent 内存队列；
- 持久化中途失败时，Driver 按已成功取消的记录重建剩余内存队列，不把部分失败伪装成全部成功；
- RPC `clear_queue` 返回分开的 `steering` 与 `followUp` 文本，Controller 随后刷新同一 durable Projection；
- Driver 重启测试确认已取消消息不会再次注入，RPC 端到端测试确认清理后不会产生额外模型请求。

第二十五批接入 canonical HTML export：

- 复用现有自包含 HTML 模板，但新增直接读取 Harness `Session` 的 v4 适配器，不再通过旧 `SessionManager` 打开文件；
- 导出数据包含所有 canonical Entry、main leaf、system prompt 与 label facts，保留树浏览和深链接能力；
- 相对输出路径按当前 Runtime cwd 解析，可创建目标目录；导出只写外部 HTML，不追加 JSONL 事实；
- RPC `export_html` 与 TUI `/export [path]` 共用 Controller 入口，并通过嵌入数据与跨目录输出测试。

第二十六批接入 prompt template：

- Coding Runtime 可加载显式模板路径与全局/项目默认模板，重复名称按现有 first-wins 规则产生资源冲突诊断；
- 项目默认模板受 project trust 约束，显式 `--prompt-template` 在 `--no-prompt-templates` 下仍可使用；
- Controller 在调用 Driver 前展开字符串或带图片用户消息，因此 canonical `operation_started.originalPrompt` 固定保存展开结果；
- Extension 命令优先于同名模板；print、TUI 与 RPC 的 command 路由和 `get_commands` 共享模板目录。

第二十七批接入 scoped models：

- `--models` 与保存的 enabled-model patterns 通过现有 resolver 生成带可选 thinking level 的候选集；
- TUI model selector、RPC available/cycle model 共用同一 scoped catalogue，RPC 返回 `isScoped`；
- 新 Session 优先使用已保存且仍在 scope 内的默认模型，否则使用 scope 首项；显式 `--model` 仍优先；
- 切入 scope 外模型时将其加入当前候选集；带 thinking level 的 scope 项切换后同步更新后续 Runtime replacement 默认值。

第二十八批接入 RPC Extension UI：

- `createHarnessExtensionContexts()` 可接收产品层 UI Context，并在 RPC 模式正确报告 `hasUI: true`；
- 新的 RPC UI service 为 select/confirm/input/editor 生成关联 id，支持 response、AbortSignal、timeout 与安全默认值；
- notify/status/string widget/title/editor text 作为单向 `extension_ui_request` 输出，终端 custom component 不跨 RPC 传输；
- Runtime replacement、RPC dispose 与输入关闭会统一取消悬挂 dialog，不让旧 Extension Scope 持有未决交互。

第二十九批接入 TUI Extension UI 基础交互：

- Harness TUI Extension Context 现在正确报告 `hasUI: true`，并复用现有 selector、input 与多行 editor 组件；
- select/confirm/input/editor 与 Session、tree、model、thinking、tool selector 及 Approval 共用单焦点边界；新交互会确定性取消旧 selector；
- dialog 支持 Escape、AbortSignal 与 timeout 安全默认值，组件退出时释放倒计时和信号监听器；
- notify、keyed status、terminal title、raw terminal input 与核心 editor text 已接入实际 TUI；
- TUI stop 与 Runtime Host replacement 会取消未决交互，恢复主 editor 焦点，不让旧 Extension Scope 悬挂。

第三十批接入 TUI Extension UI 结构扩展：

- `custom()` 支持普通单焦点组件与 TUI overlay，完成、工厂异常、view stop 和 Runtime replacement 均确定性恢复 editor；
- `setWidget()` 支持 editor 上下方的字符串或组件 widget，同名替换和 Scope reset 会调用组件 `dispose()`；
- `setHeader()` 可替换 Harness 内建 header，重载时释放自定义 header 并恢复内建组件；
- raw terminal input listener 由 view 跟踪，Extension Scope replacement 时统一解绑；
- keyed Extension status 与 canonical Runtime status 合并显示，清理扩展状态不会丢失当前 Session 状态。

第三十一批补齐 TUI Extension footer、editor provider 与 theme：

- `setFooter()` 可替换状态栏并读取 Extension keyed status；Scope reset 会释放自定义 footer 并恢复 canonical Runtime 状态栏；
- `setEditorComponent()`、`getEditorComponent()` 接入单一 editor 容器，切换时保留输入文本并释放被替换的自定义 editor；
- 自定义 `CustomEditor` 会继承 Harness 的 submit、abort、exit 与 interrupt/clear 行为，普通 `EditorComponent` 保留其自定义键盘处理；
- `getAllThemes()`、`getTheme()` 与 `setTheme()` 复用 Pi theme registry，切换成功后请求完整 TUI 重绘；
- TUI stop 与 Runtime replacement 会恢复默认 editor/footer，防止旧 Extension Scope 的组件进入新 Session。

## 一致性保护

`createComposedRuntime()` 会比较 resolved Profile 中所有 enabled 插件与即将交给 PluginHost 的实际插件集合。两者不一致时启动失败，避免未实现插件被误报为已启用。

当前 Coding Profile 中 JSONL Session、Tool Catalog、Prompt、Models、Coding Tools、Skills、Compaction、Approval、Telemetry、旧 Extension 集合、Extension bindings 和 Agent Driver 为 enabled。print、JSON、RPC 与基础 TUI 可消费该 Profile；`coding-ui` 插件仍为 disabled，当前 TUI 是产品消费端，不在 PluginHost 中声明尚未实现的 UI 插件贡献。

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
- Harness TUI 的初始输入、后续 prompt、Session 命名和未知命令边界通过 faux model 测试；
- TUI Approval 通过焦点 editor 输入完成，signal abort 会拒绝审批；
- `/sessions` 可列出当前项目 JSONL Session 并切换 Host，切换后 transcript 来自新 Projection；
- `/tree` 可从 canonical entries 回退 main lane，导航后 Projection 与模型上下文一致；
- 流式 faux response 会产生 `message_update`，最终 transcript 仅保留 committed Assistant message；
- `/fork` 保留所选分支上下文、父 Session metadata，并切换到新的 Runtime；
- `/thinking`、`/model` 与 `/tools` 均通过 Controller 更新 Projection，Fork 后保持所选运行配置；
- `/sessions all` 和 `/session <path>` 可跨 cwd 切换，Projection 明确包含当前 cwd；
- navigation intent-only 与 summary-tail 两种 JSONL 崩溃窗口均可恢复且不会重复已提交摘要；
- Extension 命令可端到端完成 new/switch/fork/reload；`withSession` 的自定义消息只进入替换后的 Session，旧 Controller 在重载后失效；
- RPC 摘要导航与跨项目参数完整通过 JSONL 解析，burst 输出保持输入响应顺序，active shutdown 最终回到 recovery idle；
- Host 并发替换互斥、RPC 缺失切换目标不产生新文件、Compaction terminal-tail 恢复不重复摘要；
- RPC Session stats、最后 Assistant 文本、Entry cursor、Fork 消息与 clone 均通过端到端验证；相对 Session path 在跨项目切换后按当前 Runtime cwd 解析；
- Driver 与 RPC 的 durable `clear_queue` 测试覆盖两类队列、取消事实、无额外模型请求和重启不恢复；
- RPC/TUI canonical HTML export 测试覆盖 v4 header、Entry、leaf、system prompt、label 与 Runtime cwd 路径解析；
- prompt template 测试覆盖显式 CLI 参数、quoted args、canonical run intent 和未信任项目默认目录；
- scoped-model 协议测试覆盖 CLI 参数接受、受限目录查询/循环与 `isScoped` 标识；
- RPC Extension UI 测试覆盖 dialog 往返、单向通知、非法响应和 dispose fail-closed；
- TUI Extension UI 测试覆盖四类 dialog、编辑器文本、标题、AbortSignal 与 replacement 取消；
- TUI custom component、widget/header dispose 与 terminal listener Scope reset 已通过生命周期测试；
- TUI footer status、custom editor 文本/释放、theme 查询与切换已通过专项测试；
- Memory/JSONL Session 后端一致性测试 96 项通过，包括 Fork 目标约束；
- 仓库全量 `npm run check`（格式、依赖锁、resolved manifest、TypeScript、browser smoke）通过。

## 下一批

继续补齐 TUI Extension autocomplete、working-indicator、hidden-thinking 与 tool-expansion 细节，并扩大结果提交前的崩溃注入测试。

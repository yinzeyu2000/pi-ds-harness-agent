# pi-ds-codex-harness agent：三源融合执行报告与开发计划

> 文档状态：规划稿 v0.1；M0 基线与决策材料已于 2026-09-03 落地  
> 编制日期：2026-09-03  
> 目标目录：pi-ds-codex-harness agent  
> 当前实现状态：Pi 固定源码基线、M0 ADR/测试/CI 骨架已建立；融合 Runtime 功能实现尚未开始  
> 总体策略：以 Pi 为代码基线，借鉴 DeepSeek Harness 的组合语义，移植 Codex Harness 的工业级 Runtime 行为契约

---

## 0. 执行摘要

本项目应当被定义为一个“轻量内核、强组合、工业执行”的 TypeScript Agent Runtime，而不是 Pi、DeepSeek Harness、Codex 三套源码的机械拼接。

建议的最终分工如下：

| 来源 | 在新项目中的主要职责 | 不应照搬的部分 |
|---|---|---|
| Pi | TypeScript 基线、模型与消息类型、流式模型适配、轻量 agentLoop、可嵌入 API、现有 Session/Protocol/Client/Server 基础 | 尚未完成的 AgentHarness 不能直接当工业 Runtime；不能继续让内存消息成为第二事实源 |
| DeepSeek Harness | Plugin、Service、Scope、Effect、静态依赖图、Profile/Bundle/Patch、工具中间件与有界调度 | 不复制大规模包结构，不引入第二套 Agent Loop、第二套 Session Log、完整 Loader/HMR/Web/PTC/Typert |
| Codex Harness | Thread/Turn/Item 语义、Submission 队列、Task 监督、Process、Sandbox、Approval、持久化边界、App Server、多 UI 复用 | 不逐文件翻译 Rust，不复制巨型 core、全部产品功能、历史兼容协议和 100+ crate 结构 |

项目必须长期保持七个“唯一”：

1. 一个前台 Runtime 状态机：ThreadRuntime。
2. 一个 Agent Loop：默认使用 Pi agentLoop。
3. 一个 canonical durable log：演进 Pi Entry/LaneRecord。
4. 一个 ModelGateway：所有 Pi 模型请求的受审计 dispatch 边界。
5. 一个 Tool/Execution Broker：所有 Agent 发起的 effectful Tool 动作入口。
6. 一套正式 Plugin API：项目自有类型，底层实现可替换。
7. 一套公开语义协议：Headless SDK、CLI、TUI 和未来 UI 共享。

推荐目标架构：

~~~text
Pi Execution Core
  负责模型、消息、工具定义和轻量 agentLoop
                 │
                 ▼
Codex-style Industrial Runtime
  Thread / Turn / Step / Task / Process / Persistence / Protocol
                 ▲
                 │
DSH-style Composition Plane
  Plugin / Service / Scope / Effect / Profile / Middleware
~~~

其中“一切皆插件”是组合原则，不是安全原则。ID 分配、事实日志、状态机、Tool Gateway、最终权限裁决、审批校验、Sandbox 执行点、进程所有权、终态 exactly-once、协议版本等必须属于 Runtime 固定安全微内核。它对公共 API 和第一方协作代码不可替换；任意同进程代码仍属于 TCB，不能把这一架构边界宣传成针对恶意插件的隔离。

建议发布节奏分成三档：

- 功能 MVP：完成 Pi Loop、Plugin Host、Memory/JSONL、快速 Turn admission、Headless SDK 与协议闭环；允许显式 trusted-local 模式，但不得宣传为安全 Runtime。
- Secure Beta：加入受管进程、审批、策略和至少一个目标 OS 的真实强 Sandbox；这是“工业执行”能力的第一道硬门。
- Industrial v1：覆盖目标平台矩阵、多 UI、长稳、故障注入、协议兼容与发布治理。

初步估算（含约 25%–35% 的跨模块集成、安全整改和平台差异缓冲）：功能 MVP 约 10–15 人周；Linux/经验证隔离 Provider 路线的 Secure Beta 约 18–30 人周；Windows-first 且强 Sandbox 从零开发约 22–38 人周；Industrial v1 约 36–65+ 人周。所有区间都需在 M0 平台 Spike 后重估。三名熟悉 TypeScript、系统编程和安全隔离的工程师并行时，Windows-first Secure Beta 可先按约 12–22 个自然周排期；核心状态机与持久化契约仍需串行收敛，不能简单按人数等比压缩。

---

## 1. 项目目标、成功标准与边界

### 1.1 项目目标

新 Agent 名称为 **pi-ds-codex-harness agent**，全部新代码、设计文档和测试均放在同名目录中。

目标是获得以下组合：

- 像 Pi 一样核心小、调用直接、容易嵌入。
- 像 DeepSeek Harness 一样可组合、可替换、生命周期清晰、扩展能力强。
- 像 Codex Harness 一样把“执行”做成可靠 Runtime：进程可监督、权限可审计、状态可恢复、协议可复用、多个 UI 不形成多份真相。

最终产品既应支持：

- 进程内嵌入：应用直接创建 Runtime/Thread。
- Headless 服务：通过稳定协议控制。
- CLI/TUI：作为 Runtime Client，而非另一套 Agent 实现。
- 后续 Web/IDE：只做协议客户端与 Projection，不接触内部状态。

### 1.2 成功标准

产品成功不以“移植了多少源码”衡量，而以以下行为衡量：

- Pi 原有轻量模型调用和工具循环仍然简单可用。
- 每个 Thread 可恢复、可观察、可中断，且最多一个前台 Turn。
- 每个 Turn 恰好产生一个终态。
- 所有 Agent 发起的 effectful Tool 动作只能经过 ExecutionBroker；模型请求、Journal 写入分别经过 ModelGateway、JournalWriter。
- 插件激活失败可事务回滚，释放顺序确定，无资源泄漏。
- durable fact 一定先达到规定的 persisted/flush 确认级别，再向插件、UI 和协议发布。
- 崩溃后不会静默重放可能已产生副作用的非幂等工具。
- 进程可以按逻辑 ID 读取输出、写入 stdin、调整 PTY、超时和终止进程树。
- 当宿主选择 Secure Profile 时，强 Sandbox 不可用必须明确拒绝，不能静默降级到 trusted-local。
- 两个以上 UI 可观察同一 Thread，但写入与审批只有一个受控 controller。
- UI、索引数据库和内存状态都不是事实源。

### 1.3 本阶段非目标

首批版本明确不做：

- 不追求与 Codex App Server 的 wire-level 兼容。
- 不把 Codex Rust 模块逐文件翻译为 TypeScript。
- 不首发多 Agent、Worktree、远程 Exec、分布式调度。
- 不首发完整 Web UI、IDE 插件或云服务。
- 不首发动态 Marketplace、在线插件安装、任意热卸载。
- 不复制 DSH 的 Loader、Include、HMR、Web/BFF、PTC、Typert 全家桶。
- 不把 SQLite 作为与 JSONL 并列的第二事实源。
- 不在 MVP 同时实现 Lane、Thread Fork 和 Subagent 三套分支语义。
- 不承诺任意外部副作用 exactly-once。
- 不承诺后台进程在整个 Runtime 崩溃后仍继续存活。
- 不把纯 Node 路径检查称为强 Sandbox。

许可证暂不作为本阶段的技术阻塞项，但仍建议保留 source-port ledger，记录每个移植概念、源码位置、重写方式和测试来源；任何公开分发应另设合规审查门。

---

## 2. 当前源码基线与现状

### 2.1 已核对的本地源码

| 仓库 | 分支/标签 | 固定提交 | 工作树 | 结论 |
|---|---|---|---|---|
| Pi | main / v0.84.4-11-gb8b873b98 | b8b873b9872db04a938fb4357b5e8e824ddc051c | 干净 | 新项目代码基线 |
| DeepSeek Harness | master / dsh-v0.1.2-alpha.4 | 4e84901e6471b79ec0338099867ebb4606d12bb5 | 干净 | 组合与插件参考 |
| Codex | main / rusty-v8-v150.4.0-1528-gb27a6321fa | b27a6321fa1a1dbb48e019d1d1296d2a13dc4261 | 干净 | Runtime 行为契约参考 |
| pi+ds harness agent | codex/m3-jsonl-recovery | 9c4ceed4fa146a7530c8bee77a4880f34764ff17 | 有未提交修改和未跟踪文件 | 仅作为原型资产，不作为可复现基线 |
| pi-ds-codex-harness agent | — | — | 除本计划外无实现代码 | 当前只创建本计划文档 |

上述提交应在 M0 冻结为基线清单。后续任何上游同步必须通过单独变更进入，禁止在实现阶段静默漂移。

### 2.2 Pi 的真实可复用边界

Pi 当前最可靠的基线是低层模型与 Agent Loop：

- packages/ai/src/types.ts
- packages/ai/src/models.ts
- packages/ai/src/utils/event-stream.ts
- packages/agent/src/types.ts
- packages/agent/src/agent-loop.ts
- packages/agent/src/agent.ts

Pi 的 Harness v2 仍是脚手架：

- packages/agent/src/harness/agent-harness.ts
- packages/agent/test/harness/agent-harness-scaffold.test.ts

prompt、resume、abort、compact、watch、lane、lanes 等能力仍会抛出 HarnessNotImplemented，create 也无法恢复非空 Session。因此，新项目不能把 AgentHarness 当成已经完成的 Runtime；应保留它的易嵌入目标，将其改造成单 Thread facade，由唯一的 ThreadRuntime 提供实际行为。

Pi 已存在的 Session 基础值得直接演进：

- packages/agent/src/harness/session/types.ts
- packages/agent/src/harness/session/session.ts
- packages/agent/src/harness/session/state.ts
- packages/agent/src/harness/reducer.ts
- packages/agent/src/harness/session/memory.ts
- packages/agent/src/harness/session/jsonl
- packages/session-backends/sqlite-node

Pi 还已有较好的 Protocol/Server/Client 基础：

- TypeBox 严格 schema。
- 协议 hello、request/response/event、Snapshot、revision。
- 长度前缀 CBOR framing 和帧大小限制。
- Client shared/exclusive lease。
- Unix transport 和慢客户端 pending-byte 限制。

需要升级的关键点：

- 当前 prompt RPC 会等待整个 Operation 完成再响应，必须改为快速 admission。
- Unix transport 在 Windows 不可用，需要 stdio 和 Windows named pipe。
- 最后一个连接断开时不能仅因“无人观察”就卸载仍有后台进程或排队任务的 Thread。
- Agent.state.messages 只能是当前 Step/Operation 缓存，不能成为第二事实源。
- 旧 Extension Runtime 应成为统一 PluginScope 的兼容 facade。

### 2.3 DeepSeek Harness 的精确借鉴范围

值得借鉴的核心源码区域：

- vendor/cordis/src/context.ts
- vendor/cordis/src/events.ts
- vendor/cordis/src/fiber.ts
- vendor/cordis/src/registry.ts
- vendor/cordis/src/service.ts
- packages/core/scope
- packages/core/agent
- packages/core/agent-loop
- packages/core/tools
- packages/core/session
- packages/boot/app-boot/src/profile.ts
- packages/llm/llm-pi-ai

应吸收的语义：

- Service Definition → Provider → Consumer。
- provides/requires/optional 静态依赖。
- 激活前完成 DAG 校验。
- Scope 管理资源所有权。
- 每个贡献返回可逆 Effect。
- activate 事务失败时 LIFO 回滚。
- Profile/Bundle/Patch 做确定性组合。
- 工具使用有界 rolling pool。
- exclusive 工具形成 barrier。
- 并发执行可按完成顺序反馈 live progress，但模型结果按原始 call index 提交。
- abort 后停止接纳新工具并 drain 已开始的工作。
- lossless snapshot、连续 seq、deep freeze、纯 Projection、未知 required event fail closed。

不应吸收：

- DSH Session 不能成为第二份 canonical log。
- DSH Agent Loop 不能替代 Pi agentLoop。
- Cordis 类型不能泄漏到公共 Plugin SDK。
- 不复制全部包、Loader/HMR 和产品层。

### 2.4 Codex Harness 的精确借鉴范围

Codex 源码应当作为 Runtime 语义与失败模式的参考，重点区域包括：

- codex-rs/protocol/src/protocol.rs
- codex-rs/core/src/thread_manager.rs
- codex-rs/core/src/session
- codex-rs/core/src/state/turn.rs
- codex-rs/core/src/tasks
- codex-rs/core/src/tools
- codex-rs/core/src/unified_exec
- codex-rs/sandboxing
- codex-rs/thread-store
- codex-rs/rollout
- codex-rs/app-server
- codex-rs/app-server-protocol
- sdk/typescript

应移植的行为契约：

- 每个 Thread 一个有序 Submission 控制邮箱。
- Thread、Turn、Step/Item、Task、Process 的生命周期分离。
- ActiveTurn 和 RunningTask 的唯一所有权。
- 分阶段取消、清理、持久化和终态发布。
- 统一 Process Supervisor。
- Policy、Approval、Sandbox 三层分离。
- append、persist、flush、shutdown、discard 明确分工。
- JSONL 事实先落盘，SQLite 只作可重建查询投影。
- App Server 的 initialize、能力协商、订阅、反向审批请求、背压和多 UI 复用。

不应复制：

- Rust 语言和 100+ crate 的复杂模块图。
- 巨大的 core 聚合模块和超大联合事件类型。
- 全量 legacy、v2、experimental 兼容面。
- 云端、语音、guardian、remote-control 等产品功能。
- 对可能已有副作用的命令做不安全自动重试。

Codex 官方资料也明确把 App Server 描述为可供不同客户端复用、提供认证、会话历史、审批和事件流的协议面；Sandbox 与 Approval 是两个独立控制维度。这些外部语义已与本地源码交叉核对：

- [Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex sandboxing](https://learn.chatgpt.com/docs/sandboxing)
- [Codex open source](https://learn.chatgpt.com/docs/open-source)

### 2.5 旧 pi+ds harness agent 的定位

旧目录中已有可借鉴的原型资产，例如：

- plugin-host.ts
- services.ts
- events.ts
- profile.ts
- projections.ts
- tool-pipeline.ts
- pi-agent-driver.ts
- minimal-runtime.ts
- JSONL recovery 和 Plugin Host 测试

但该目录目前存在未提交修改，因此：

- 不得把旧报告中的 M3/M4“已完成”状态复制到新项目。
- 不得直接把整个目录覆盖到新目标。
- 应先冻结一个明确 snapshot，再按文件和行为逐项移植。
- 可保留 Plugin DAG、LIFO Effect、Profile 组合、JSONL recovery、Pi Driver replay policy 等原型。
- 必须重构全局 scope、过早 tool_started、Pi 内存状态权威化、缺失 ThreadManager/Process/Sandbox/App Server 等问题。

---

## 3. 总体融合决策

### 3.1 采用“基线 + 适配器 + 行为契约”

代码层采用 Pi；DSH 和 Codex 主要通过行为测试、接口契约和设计模式进入新项目。

~~~text
保留 Pi 代码
    +
新增 DSH-style Composition Plane
    +
新增 Codex-style Runtime Plane
    =
pi-ds-codex-harness agent
~~~

禁止采用：

- 三仓目录拼接。
- 三个 Agent Loop 并存。
- 三套 Session/History/Event Store 并存。
- Plugin Host 与 Agent Extension Host 双轨长期维护。
- 另建一套 Codex App Server，绕开 Pi 已有 Protocol/Server/Client。

### 3.2 三层职责

#### A. Pi Execution Core

负责：

- Model/Provider 适配。
- Message、Tool、Stream 等基本类型。
- 轻量 agentLoop。
- AgentDriver 所需的模型交互。

不负责：

- Thread 生命周期。
- durable log 提交顺序。
- 进程和 Sandbox。
- UI 协议和多连接控制权。

#### B. DSH-style Composition Plane

负责：

- Plugin Manifest 与依赖图。
- Service Token、Provider、Consumer。
- runtime/thread/turn Scope。
- Effect 注册、回滚和释放。
- Profile/Bundle/Patch。
- Prompt、Context、Tool、Telemetry 等扩展点。

不负责：

- 最终安全决策。
- 事实日志的直接写入。
- Tool body 的直接绕过执行。
- Turn terminal 状态。

#### C. Codex-style Industrial Runtime Plane

负责：

- RuntimeHost、HostLifecycleCoordinator、ThreadManager、ThreadRuntime。
- LoadedThreadMailbox 与 ActiveTurn。
- Turn/Step/Task 状态机。
- ModelGateway 与 ModelAttempt。
- ExecutionBroker、ProcessSupervisor。
- Policy、Approval、Sandbox。
- canonical journal、recovery、projection。
- Runtime Protocol、App Server、Client 和多 UI。

### 3.3 安全微内核

以下内容不能通过公共 Plugin API 替换或绕过：

1. ID、序列号和 command dedupe 分配。
2. Thread/Turn/Step/ToolAttempt 状态机。
3. canonical log 的唯一 append/flush 入口。
4. durable-before-publish 顺序。
5. ModelGateway 的 pre-dispatch barrier。
6. Tool Gateway 和 ExecutionBroker。
7. 最终单调权限合并。
8. Approval fingerprint 校验。
9. Sandbox enforcement point。
10. Process ownership、配额和进程树清理。
11. Turn terminal exactly-once。
12. 协议 envelope、schema 和版本协商。
13. PluginScope 的 Task 监督与 shutdown 顺序。

插件可注册策略或 Guard，但只能收紧权限，不能把 deny 变为 allow。该约束保护正常扩展路径；任意同进程插件都属于 TCB，恶意代码仍可调用宿主 API，因此 Secure Profile 必须限制 TCB 插件，并把不可信扩展移出进程。

宿主有三条受审计的 effectful 控制路径：

- ModelGateway：模型 Provider 请求、重试、usage 和 request ID。
- JournalWriter：事实写入和 durability barrier。
- ExecutionBroker：Agent 发起的 WorkspaceFS、Network、Process Tool 动作。

TCB 插件若直接使用系统 API，技术上处于这些架构路径之外，因此必须经过代码审查/allowlist，且不能被安全声明描述为“不可信插件也无法绕过”。

---

## 4. 统一领域词汇与身份模型

三个项目对 Turn、Session、Agent、Task 的含义不完全一致，必须先冻结公共词汇。

### 4.1 推荐对象层级

~~~text
RuntimeHost
└─ HostLifecycleCoordinator
   └─ ThreadManager
      └─ ThreadRuntime
         ├─ runtimeGeneration
         ├─ CanonicalJournal
         ├─ PluginScope
         ├─ LoadedThreadMailbox
         ├─ ActiveTurn?            # 最多一个前台 Turn
         │  ├─ Step 1
         │  ├─ Step 2
         │  └─ RuntimeTask*
         └─ BackgroundProcess*
~~~

### 4.2 统一定义

| 名称 | 定义 |
|---|---|
| RuntimeHost | 当前宿主进程内的总 Runtime，可管理多个 Thread |
| HostLifecycleCoordinator | 串行化冷启动、恢复、卸载、归档、删除等宿主级生命周期 |
| Thread | 用户可见、可持久化、可恢复的会话身份；对应一个 Pi Session |
| Session | 避免作为第二公共概念；内部可表示 Thread 当前加载到内存的 residency |
| Lane | Pi 的历史分支指针；MVP 保留 main lane，但不公开完整分支功能 |
| Operation | run、compaction、navigation 等通用持久操作 |
| Turn | 一次用户任务/提交，对应一个 run Operation，恰好一个终态 |
| Step | 一次模型请求、assistant response 和相应工具批次 |
| Item | 面向 UI/协议的消息、工具调用、命令、文件修改等展示单元 |
| Task | Runtime 内部可取消异步工作，不作为外部事实源 |
| ToolAttempt | 某次冻结参数与策略后的具体执行尝试 |
| Process | 由 Runtime 管理的 OS 进程；wire ID 不等于 OS PID |
| AgentHarness | 单 Thread 的易嵌入 facade，不拥有第二个协调器 |
| Pi agentLoop | 默认 AgentDriver 的模型循环 |

Pi 的 AgentEvent.turn_start/turn_end 实际表示“一次 assistant response 加工具批次”，应映射为公共 Step，而不是公共 Turn。Step 是本项目为适配 Pi 引入的内部/扩展协议概念，并非必须照搬 Codex App Server 的顶层 wire 原语。

### 4.3 关联标识

所有 durable event 必须包含 threadId；按上下文还应包含：

- lane
- operationId
- turnId
- stepId
- taskId
- itemId
- toolCallId
- toolAttemptId
- processId
- commandId/clientRequestId
- eventId
- runtimeGeneration
- controllerLeaseEpoch
- causationId
- correlationId
- traceId

任何 API 不得仅依赖“当前 Turn”隐式寻址关键副作用。interrupt、approval reply、process stdin 等都必须校验精确身份，防止晚到命令误作用于新对象。

---

## 5. Runtime 状态机与不变量

### 5.1 Thread 持久生命周期与内存驻留

Thread 的持久生命周期与当前是否加载到内存必须分开。

~~~text
Durable lifecycle:
active ─► archived ─► active
  └─────────────────► deleted   # 真正不可恢复
~~~

~~~text
Residency:
not_loaded
    │ load/start
    ▼
starting ───────► idle ◄──────────── active
    │              │                    │
    │ failure      │ unload             │ turn terminal
    ▼              ▼                    │
failed         stopping ──────► not_loaded
~~~

协议中的 thread.closed/unloaded 只表示当前内存 Runtime 已卸载，持久 Thread 仍可 resume；只有 deleted 才是不可恢复的持久终态。

Thread residency 不仅由 UI 订阅决定。满足任一条件时 Thread 可保持加载：

- 有 subscriber/controller。
- 有 active Turn。
- 有后台 Process。
- 有排队命令或调度任务。
- 有显式 pin/lease。
- 有待处理审批或受管资源。

后台 Process 不能无限阻止卸载。它必须具备显式 pin、TTL、最大存活时间、数量/输出配额和宿主退出策略；资源超限时按策略终止或转交外置 Process Supervisor。最后一个 UI 断开本身不足以立即 dispose Thread，但无人订阅且无有效 pin 的空闲 Thread 应按延迟卸载策略释放。

每次加载生成新的 runtimeGeneration。所有 listener、延迟 unload、revert 和 shutdown 都使用 compare-and-remove，只能删除自己创建的 generation，避免旧 Runtime 的晚到清理误删同一 Thread 的新实例。

### 5.2 Turn 状态

~~~text
Turn.phase:
admitted ─► in_progress ─► completed | interrupted | failed

Turn.activeFlags / pending maps:
waitingOnApproval[]
waitingOnUserInput[]
runningTasks[]
cancellationRequested?
~~~

等待审批和等待用户输入不是互斥的 Turn 主状态；具体 waiter 归属相应 ToolAttempt/Task，并行场景下可以同时存在多个 pending request。Turn 只聚合 active flags，UI 的 waiting 状态由 pending maps 派生，Turn 对外仍是 in_progress。

不变量：

- 一个 Thread 同时最多一个 ActiveTurn。
- 一个 Turn 恰好一个 completed/interrupted/failed terminal fact。
- 终态落盘后不再接受属于该 Turn 的新副作用。
- interrupt 必须带 turnId，晚到 interrupt 不得取消后续 Turn。
- 当前 Step 冻结的模型、Prompt、Tool schema、权限和环境在执行中不可变。
- 配置与插件变化只在下一个安全边界生效。

### 5.3 HostLifecycleCoordinator

未加载的 Thread 没有可接收 resume 的 Session mailbox，因此宿主级生命周期必须在 ThreadRuntime 之外按资源键串行：

- thread/start
- thread/resume
- thread/unload/suspend
- thread/archive/delete
- 未来的 thread/fork/revert

HostLifecycleCoordinator 负责：

- 按 threadId/resource key 排序，允许不同 Thread 并行。
- 创建并注册新的 runtimeGeneration。
- 在返回 resume snapshot 前完成 listener 安装和 watermark 捕获。
- 请求已加载 Runtime 有界停止、flush、关闭 writer。
- 使用 generation fencing 注销，避免旧回调删除新实例。
- 汇总 shutdown 结果：completed、submitFailed、timedOut；超时对象显式保留并告警，不能静默删除。

Runtime 注册成功后，对客户端可见的第一个 Thread 事件必须是完整 configured/started snapshot，再允许增量 Item 事件。

### 5.4 LoadedThreadMailbox

只有已经加载的 Thread 控制命令进入该 Thread 的单一有序邮箱：

- turn/start
- turn/steer
- turn/interrupt
- approval/respond
- settings/update
- compact
- internal quiesce/shutdown

耗时 Task 可以异步执行，但“是否接纳、作用于哪个对象、修改哪种状态”必须由 ThreadRuntime 串行决定。

调用方停止等待并不等于撤销已经 admitted 的 Turn。clientRequestId 重试必须返回原 admission 结果，而不能重复创建 Turn。

### 5.5 取消协议

取消不是简单调用 AbortController：

1. ThreadRuntime 标记 Turn 为 cancelling。
2. 停止接纳新的 ToolAttempt 和外部副作用。
3. 触发协作取消信号。
4. 按 Task 类型等待可配置 grace period。
5. 强制中止仍未结束的 Task。
6. 清理前台 Process；显式提升到 Thread 的后台 Process按其策略保留。
7. 等待已启动工作完成清算或标记 outcome_unknown。
8. append + flush interruption facts。
9. append + flush 唯一 terminal。
10. 发布 terminal live/wire event。
11. 清除 ActiveTurn。
12. 释放 Turn Scope 和 pending request。

取消与正常完成并发时必须由单一 compare-and-set/状态机路径裁定，只能有一个获胜终态。

---

## 6. Plugin 与组合系统

### 6.1 公共 Plugin 契约

项目应拥有自己的稳定类型，底层可用 Cordis adapter 或自研实现：

~~~ts
interface ServiceRef {
  id: string;
  versionRange?: string;
  cardinality?: "one" | "many";
}

interface PluginManifest {
  id: string;
  version: string;
  provides?: ServiceRef[];
  requires?: ServiceRef[];
  optional?: ServiceRef[];
  capabilities?: string[];
}

interface Plugin {
  manifest: PluginManifest;
  activate(context: PluginContext): void | Promise<void>;
}

interface Effect {
  dispose(): void | Promise<void>;
}

interface PluginContext {
  defer(disposer: () => void | Promise<void>): void;
  use<T>(resource: T, disposer: (resource: T) => void | Promise<void>): T;
  listen<T>(event: EventToken<T>, listener: (event: T) => void): Effect;
  task<T>(run: (signal: AbortSignal) => Promise<T>): ManagedTask<T>;
  provide<T>(token: ServiceToken<T>, value: T): Effect;
}
~~~

要求：

- 激活前解析完整依赖 DAG。
- 缺失 required service、环依赖或重复 provider 在执行任何 activate 前失败。
- 激活顺序确定，释放顺序严格反向。
- PluginContext 必须在资源创建时通过 defer/use/listen/task/provide 立即登记 Effect；不能等 activate 返回后才获得 disposer。
- activate 中途失败时回滚本次事务已经即时登记的全部 Effect。
- dispose 抛错时继续释放其余资源，最终聚合报告。
- 重复 dispose 幂等。
- Listener、Timer、Task、Process、Service registration 都必须进入 Scope 所有权。
- Manifest capabilities 只是需求声明，不自动授予权限；实际能力必须由 Host 以受限 capability handle 发放。
- 公共 ServiceToken<T> 使用项目自有泛型类型，不能退化为长期裸字符串。

### 6.2 Scope

首版建议：

~~~text
RuntimeScope
└─ ThreadScope
   └─ TurnScope
      └─ TaskScope
~~~

- RuntimeScope：全局 Provider、模型目录、存储工厂、平台能力。
- ThreadScope：Thread 插件状态、工具集合、后台 Process、订阅。
- TurnScope：当前 Turn 的取消、审批、临时 Context 和前台资源。
- TaskScope：轻量资源托管，不再形成可任意覆盖 Service 的复杂层级。

### 6.3 三类事件域与一个投影域

| 域 | 用途 | 是否事实源 |
|---|---|---|
| Durable Facts | 恢复相关的事实，包括 intent、started、result、terminal | 是，唯一 |
| Live Events | token delta、工具进度、进程输出、瞬时诊断 | 否 |
| Middleware | Prompt、Context、Tool pre/guard/around/post、Telemetry | 否 |
| Wire Projection | Durable/Live 的版本化协议表示 | 否 |

高频 token delta 和 process output 默认不逐条写 canonical log；最终 Message、Tool Result、Process terminal 和必要的 spill 引用才持久化。

### 6.4 Profile、Bundle 与 Patch

Profile 只描述确定性组合：

- minimal：Pi Driver、Memory/JSONL、最小工具和 in-process/stdin transport。
- coding：文件工具、Shell/PTY、Approval、Sandbox、Compaction、TUI。
- test：Fake LLM、Fake Process、Fake Sandbox、故障注入 Provider。

Bundle 是明确版本集合，Patch 是纯数据覆盖。禁止在配置里嵌入任意 JavaScript；动态行为必须由已注册插件提供。

### 6.5 Cordis 决策 Spike

M1 用最多 3 人日比较：

1. 私有 Cordis adapter。
2. 小型自研 PluginHost。

旧 pi+ds harness agent 的 self-host PluginHost 作为 incumbent 进入比较；只有在 TaskScope、并发释放、错误隔离或性能 conformance 上明显不足时才更换。

使用同一 conformance suite 比较：

- 冷启动耗时和包体积。
- Service/Scope 隔离。
- activate 事务回滚。
- Effect 精确释放。
- 错误与 shutdown 语义。
- 类型泄漏风险。

决策后只保留一个实现。公共 Plugin SDK 永远不暴露 Cordis 类型。

### 6.6 插件信任模型

- 同进程 TypeScript 插件属于完全信任计算基（TCB），技术上可以直接加载 fs、child_process、HTTP 或 native addon；架构守卫只约束协作代码，不是对恶意同进程代码的安全边界。
- Scope 解决生命周期与组合，不提供安全隔离。
- Secure Profile 只能加载明确 allowlist 的 TCB 插件；不可信插件必须进入受 capability IPC 限制的 Worker、MCP 或独立进程。
- 插件不能直接访问 canonical writer、Turn terminal transition 或 Process registry。
- 对第一方代码，fs、child_process、node-pty 和网络库的直接依赖通过架构测试限制到指定 Provider 包。
- 插件持久状态只能通过命名空间化 fact command API 提交，由 Runtime 校验并写入；不暴露 canonical writer。

---

## 7. 唯一事实源、事件溯源与恢复

### 7.1 Canonical Journal

演进 Pi Entry/LaneRecord，不新增 DSH SessionEvent Log 或 Codex Rollout Log。物理日志只有一种：下述 JournalEnvelope 是 Pi Session 记录的版本化包络，不是并列的第三套事件模型。

保留可判别联合，禁止退化为 kind: string + payload: unknown：

~~~ts
type JournalRecord =
  | { recordType: "entry"; entry: Entry }
  | { recordType: "lane"; laneRecord: LaneRecord }
  | { recordType: "runtime_fact"; fact: RuntimeFact };

type RuntimeFact =
  | TurnFact
  | StepFact
  | ModelAttemptFact
  | ToolAttemptFact
  | ApprovalFact
  | ProcessFact
  | ConfigurationFact;

interface JournalEnvelope<R extends JournalRecord = JournalRecord> {
  schemaVersion: number;
  eventId: string;
  seq: number;
  threadId: string;
  lane?: string;
  operationId?: string;
  turnId?: string;
  stepId?: string;
  commandId?: string;
  causationId?: string;
  correlationId?: string;
  timestamp: number;
  record: R;
  checksum: string;
}

type JournalDraft<R extends JournalRecord = JournalRecord> =
  Omit<JournalEnvelope<R>, "eventId" | "seq" | "timestamp" | "checksum">;
~~~

eventId、seq 和 timestamp 由持有 fence 的 writer 在原子 append 中分配，调用方只提交 JournalDraft，不能预分配顺序号。seq 在单个 Thread 内严格连续。

至少持久化：

- Thread 创建、配置版本和 Profile/Plugin manifest hash。
- Turn admitted、started、terminal。
- Step request snapshot。
- ModelAttempt prepared、dispatch_intent、response_started、completed/outcome_unknown。
- User/Assistant 最终消息。
- Tool raw call、attempt_prepared、execution_dispatch_intent、execution_started、result、outcome_unknown。
- Approval 决策摘要，不含敏感 token。
- Process started/terminal 和必要的输出引用。
- Interrupt/recovery marker。
- Compaction replacement。

### 7.2 Store 契约

ThreadJournalStore 是 Pi SessionRepo/SessionStorage 的演进或兼容 facade，不是并列 writable store。如果源码迁移到 journal-core，原 Pi 实现必须迁移或 re-export，不能在新旧目录各保留一套权威实现。

~~~ts
interface ThreadJournalStore {
  open(threadId: string): Promise<JournalWriter>;
  load(threadId: string): AsyncIterable<JournalEnvelope>;
}

interface JournalWriter {
  append(drafts: readonly JournalDraft[]): Promise<AcceptedReceipt>;
  persist(upToSeq?: number): Promise<PersistedReceipt>;
  flush(upToSeq?: number): Promise<PowerLossDurableReceipt>;
  checkpoint(): Promise<CheckpointRef>;
  shutdown(): Promise<void>;
  discard(): Promise<void>;
}
~~~

三种确认级别：

| 级别 | 含义 |
|---|---|
| accepted/enqueued | writer 已原子分配 eventId/seq 并接受到有序队列，尚不能对外声称可恢复 |
| persisted/readable | 字节已写入底层存储并可由新 reader 重读，可抵抗正常进程崩溃；不承诺突然掉电 |
| power-loss durable/fsync | 文件内容及必要元数据已执行平台 durability barrier |

方法语义：

- append：只负责原子分配身份、接受并排序 JournalDraft。
- persist：排空到可读取的底层存储；也可在尚无 Turn Item 时物化 Thread。
- flush：在指定 watermark 上完成 fsync/等价平台 barrier。
- checkpoint：创建可验证的 Projection 加速点，不替代 Journal。
- shutdown：停止接纳、persist、flush 并关闭 writer。
- discard：只释放初始化失败的 live writer 和尚未发布的临时状态，绝不能删除此前已持久化历史。

其他约束：

- 同一 Thread 同时只允许一个 writable writer，跨进程使用 lease/fence。
- durable 模式下 terminal flush 失败，Thread 进入 degraded/faulted，不能向 UI 宣称可靠完成。
- 每个 Thread 只选择 Memory、JSONL 或未来其他 canonical backend 中的一种；查询索引没有写事实权限。

### 7.3 JSONL 与 SQLite

功能 MVP 推荐：

- Memory Store：测试和临时嵌入。
- JSONL Store：canonical history。
- SQLite Thread Index：保存 Thread 列表、搜索、分页等可重建索引，不实现 Journal append API。

顺序固定：

~~~text
append JSONL
→ persist to readable watermark
→ publish stable Wire Projection with durability watermark
→ 在安全/终态边界 flush
→ async update SQLite projection
~~~

SQLite 投影可以暂时落后，但绝不能领先于 JSONL。删除 SQLite 后必须能够从 JSONL 完整重建。

JSONL 需要：

- 检测并截断最后一条半写记录。
- 中段损坏 fail closed，不静默跳过。
- writer 原子分配的单调 seq 和必填 checksum。
- 原子 checkpoint 元数据。
- 明确 fsync 策略，而不只依赖 appendFile 返回。
- writer lease/fence，拒绝双写。

### 7.4 write-before-publish

任何恢复相关事实必须：

1. 生成不可变 event。
2. append。
3. 至少 persist 到 readable watermark。
4. 更新内存 Projection。
5. 发布 Plugin observer。
6. 发布版本化 Wire Projection，并标注对应 durable watermark；只有完成 flush 后才能声称 power-loss durable。

不得使用“先通知 tools/result，再追加日志”的顺序。

建议 durability barrier：

| 边界 | 最低要求 |
|---|---|
| token/tool/process live progress | 不进 Journal；best effort |
| 普通最终 Message/Item | persist 后发布；可按 Step 批量 flush |
| command receipt 与 durable Turn admission | durable Profile 中 flush |
| 模型或 Tool 的副作用 dispatch_intent | 执行前 flush |
| Tool authoritative result | 按实际完成顺序 append；进入下一模型 Step 前 flush |
| Turn terminal / suspend / handoff | 发布终态前 flush |

并发 Tool 的结果不等待较早 callIndex 才持久化；每个结果携带 callIndex，按实际完成顺序尽快 append。只有构造下一次模型输入时按原始 callIndex 排序。实现可以在有界短窗口内合并 flush，但不能跨越下一模型请求或 terminal barrier。

### 7.5 Projection

- Projection 是纯函数。
- Replay 只还原状态，绝不执行 Command、Tool 或 Process。
- 在线 canonical durable projection 与全量 replay projection 必须深度相等；subscriber、timer、Process handle、lease、pending live delta、当前时钟等 residency state 明确排除。
- 未知且非 ignorable 的 required event 阻止 resume。
- UI 只消费 Snapshot/Event Projection，不保存第二份业务权威状态。

### 7.6 Step Snapshot

每个 Step 必须记录或内容寻址地引用：

- 最终 system prompt。
- 模型和 Provider options。
- model-visible message/context。
- Tool schema、执行模式与策略版本。
- workspace/cwd。
- Permission/Sandbox profile。
- Plugin/config generation。
- retry/idempotency policy。

仅记录 Profile 名称不足以可靠重放和审计。

### 7.7 Blob 与敏感数据

- 大图像、大工具输出、进程 spill 使用 content-addressed blob store。
- Blob 先持久化，再把 hash/ref 写入 Journal。
- Journal、Blob、spill、writer lock、IPC endpoint 和未决审批状态位于 Sandbox 不可访问的 host-private 目录，并使用 owner-only 权限/ACL；不得放在 Agent 可写 workspace。
- Blob/spill 需要配额、引用计数或 mark-and-sweep、孤儿回收、权限和敏感内容加密策略。
- 环境变量、认证 token、Approval token、宿主凭据不得写入 Journal。
- 错误对象进入日志前应经过结构化和脱敏。
- 子进程采用最小环境白名单，不默认继承全部宿主环境。

### 7.8 崩溃恢复矩阵

| 崩溃位置 | 恢复行为 |
|---|---|
| Turn admitted，model.prepared 尚未 dispatch | 可重新进入 Step |
| model.dispatch_intent/response_started 后无 completed | 默认 model outcome_unknown，避免静默重复计费；仅在 Provider requestId 支持查询/续传时 reconcile |
| Assistant final 已持久化，UI 未收到 | 从 cursor 重放，不重新请求模型 |
| raw tool call/attempt_prepared 已记录，dispatch_intent 未记录 | 可重新进入 Policy/Approval |
| execution_dispatch_intent 已记录，无 result | 保守标记 outcome_unknown；若 Broker 证明未开始才可开新 Attempt |
| execution_started 已确认，无 result，非幂等 | 标记 outcome_unknown，不自动重试 |
| 幂等工具有稳定 key 且 Provider 可核对 | reconcile 后补记结果或开启新 Attempt |
| process.started 后无 terminal | 只有外置持久 Process Supervisor 支持时尝试 reattach；普通 Node Runtime 崩溃后进入 interrupted/unknown |
| Turn terminal 已持久化，协议未送达 | 客户端从 durable cursor 补发 |
| JSONL 最后一行半写 | 截断至最后完整记录 |
| JSONL 中段损坏 | 报 corruption，禁止静默恢复 |

---

## 8. Pi AgentDriver 融合

### 8.1 Driver 数据流

~~~text
ThreadRuntime 冻结 StepSnapshot
→ 从 Canonical Projection 构造 Pi AgentContext
→ 只向 Pi agentLoop 注入 RuntimeModelAdapter
→ RuntimeModelAdapter 调用 StepCoordinator / ModelGateway
→ Journal flush model.dispatch_intent
→ 底层 Model Provider 发起请求
→ PiEventTranslator
→ Durable Commit
→ Runtime Live Event
→ Protocol Projection
~~~

Pi Driver 不能长期拥有权威 transcript。Pi Agent 内存状态只用于当前 Step/Turn 的执行缓存，恢复时必须从 canonical Projection 重建。

Driver 优先直接调用 Pi 的低层 runAgentLoop/agentLoop，不长期持有 Pi Agent 实例。steer、follow-up、idle 和 cancel 全部由 LoadedThreadMailbox 决定，避免 Pi PendingMessageQueue 与 Runtime 邮箱并存。Pi agent_start/agent_end 只表示一次 Driver run 生命周期，不能生成第二套 Thread/Turn 状态。Pi Loop 不能持有可直接访问网络的裸 Model Provider，只能使用 RuntimeModelAdapter。

### 8.2 Pi 事件映射

| Pi 事件 | 新 Runtime 语义 |
|---|---|
| turn_start | step.started |
| turn_end | step.completed |
| message_update | live delta，不持久化 |
| message_end | 先追加最终 Message，再发布 item.completed |
| tool_execution_start | 仅作内部观察；不直接写 Journal |
| tool_execution_update | live progress |
| tool_execution_end | 缓冲结果；由 ToolAttemptCoordinator 唯一提交后再发布 tool.completed |

原始 Pi AgentEvent 不直接暴露到公共协议，避免把 Pi 的 Turn 语义泄漏为公共 Turn。

### 8.3 Tool wrapper

传给 Pi agentLoop 的 AgentTool.execute 必须是 Runtime Broker wrapper，而不是插件的裸 handler。

Wrapper 负责：

- 识别已冻结的 PreparedExecution。
- 校验 toolCallId/attemptId。
- 进入固定 Policy/Approval/Sandbox 链。
- 调用 ExecutionBroker。
- 归一化 result。
- 确保持久化完成后才把结果交回模型。

ThreadRuntime 内的 ToolAttemptCoordinator 是 Tool 事实的唯一提交者。PiEventTranslator、Broker wrapper 和 Pipeline 不得分别重复写结果：

- Assistant Entry 保存模型原始 tool call/arguments。
- ToolAttemptFact 保存 prepared、dispatch_intent、started 和内部 outcome。
- 模型可见 ToolResult Entry 只提交一次并引用 toolAttemptId。
- Pi tool_execution_end 只提供待提交数据，等 ToolResult Entry 成功后再发布公共 completion。

### 8.4 ModelAttempt 与恢复

模型调用也可能产生费用和不可重复结果，必须像 ToolAttempt 一样建模：

~~~text
model.prepared
→ model.dispatch_intent
→ model.response_started
→ model.completed | model.failed | model.outcome_unknown
~~~

ModelGateway 是可执行的 pre-dispatch 拦截点：

~~~ts
interface ModelGateway {
  stream(request: FrozenModelRequest, context: ModelAttemptContext): ModelEventStream;
}
~~~

调用顺序固定：

1. StepCoordinator 冻结请求并提交 model.prepared。
2. append + flush model.dispatch_intent。
3. ModelGateway 才调用底层 Provider。
4. 首个 Provider receipt/token 到达时提交 response_started 和 providerRequestId。
5. 最终响应、usage 和 finish reason 由 StepCoordinator 唯一提交。

- dispatch_intent 前失败可以安全重试。
- dispatch_intent 后崩溃时，不能默认重新请求模型；记录 Provider request ID、idempotency key、usage 和可续传能力。
- Provider 支持查询/续传时先 reconcile。
- 无法核实时进入 outcome_unknown，由策略或用户决定是否发起一个明确的新 ModelAttempt。
- token delta 仍是 live event；只有最终响应、usage 和 request reference 进入 Journal。
- StepCoordinator 是 ModelAttempt 事实的唯一提交者；Provider callback 和 PiEventTranslator 只上报数据，不能各自写 Journal。

---

## 9. Tool Runtime 与副作用语义

### 9.1 固定 Tool Pipeline

推荐不可改变的主顺序：

1. 将 Assistant final 和模型原始 tool call/arguments 持久化。
2. resolve tool 和当前 StepSnapshot。
3. prepareArguments + validate，形成 effective args。
4. 冻结 PreparedAction，包括 program/argv、cwd、env allowlist、roots、network、ResourceLimits、tty。
5. 提交 tool.attempt_prepared。
6. 执行核心 policy intersection、plugin guard 和 Approval。
7. 被拒绝时由 ToolAttemptCoordinator 写入一次结构化 ToolResult，不运行 body。
8. 执行前 append + flush tool.execution_dispatch_intent。
9. 仅通过 ExecutionBroker 调用 WorkspaceFS、Network 或 Process/Sandbox Provider。
10. Provider 确认文件事务/请求/进程已创建时提交 tool.execution_started/process.started。
11. 执行 body，随后运行 post/finalizeResult middleware。
12. 归一化并冻结 authoritative result。
13. ToolAttemptCoordinator 按真实完成顺序提交 outcome 与唯一 ToolResult Entry。
14. 达到所需 durability barrier 后发布 plugin/UI/protocol completion。
15. 全批结果按模型原始 callIndex 排序，进入下一模型 Step。

execution_dispatch_intent 是副作用前的安全屏障；execution_started 只表示 Provider 已确认执行实体开始。intent 已落盘但 Provider 尚未确认的崩溃窗口会保守地产生 outcome_unknown，这是假阳性换取不重复副作用的有意选择。

Secure Profile 中，effectful Tool 不执行任意 JavaScript body，而是生成声明式 PreparedAction：

- WorkspaceFS Provider：read/write/edit/rename 等受控文件动作。
- Network Provider：HTTP/MCP/远程服务动作。
- Process Provider：程序、argv、PTY 和 stdin 动作。

纯计算 Tool 可在进程内运行；任意同进程第三方 Tool 属于 TCB，不能纳入强安全声明。

### 9.2 并发与顺序

- 未声明并发安全的 Tool 默认 sequential。
- parallel-safe Tool 进入有界 rolling pool。
- exclusive Tool 在队列中形成前后 barrier。
- live progress 可按真实完成顺序发布。
- durable result 按真实完成顺序立即提交，并携带 callIndex；只有模型回填按原始 callIndex 排序。
- cancel 后不再启动未开始的副作用。
- 已启动 Tool 必须 drain、终止或明确标记 outcome_unknown。

Pi 当前批调度语义无法仅靠单个 execute wrapper 变成 DSH rolling pool。因此需要对 Pi 做一个受控小改动，抽出唯一 ToolBatchScheduler seam：M2 先提供顺序 Fake Scheduler，M4/M5 再提供有界 rolling pool/exclusive barrier。一个 Step 只能有一个 Scheduler，禁止 Pi 和 ToolRuntime 重复调度。

### 9.3 重试与幂等

- 外部非幂等 Tool 默认 at-most-once。
- 每个重试都是新的 toolAttemptId。
- 仅在有稳定 idempotency key 且 Provider 明确支持时自动重试。
- 或由 Broker 证明进程/请求从未创建，才可安全重新尝试。
- Sandbox denial 本身不能证明命令未产生副作用。
- body 已开始但 result 未持久化时，恢复为 outcome_unknown，等待 reconciliation 或用户确认。

### 9.4 错误分类

区分：

- user/tool error：可作为模型可见 Tool Result。
- policy denied：结构化拒绝，不运行 body。
- approval denied/expired/disconnected：结构化拒绝。
- sandbox unsupported/denied：基础设施与策略结果。
- execution failed：进程或 Provider 失败。
- runtime invariant/store failure：立即中止 Turn，不能伪装成普通 Tool Error 让模型继续。
- outcome_unknown：不能断言成功或失败，禁止默认重放。

---

## 10. Process Runtime

### 10.1 ProcessSupervisor 接口

~~~ts
interface ProcessSupervisor {
  spawn(spec: ProcessSpec, context: ExecutionContext): Promise<ProcessHandle>;
  read(processId: ProcessId, options?: ReadOptions): Promise<OutputBatch>;
  write(processId: ProcessId, input: Uint8Array): Promise<void>;
  resize(processId: ProcessId, cols: number, rows: number): Promise<void>;
  interrupt(processId: ProcessId): Promise<void>;
  terminate(processId: ProcessId): Promise<ProcessOutcome>;
}
~~~

ProcessId 是不可预测、不可复用的逻辑 ID，绝不能以 OS PID 作为 wire identity。

### 10.2 Process 状态

~~~text
reserved
→ starting
→ running
→ exited | failed | killed | timed_out | unknown
~~~

结果字段正交表达：

- exitCode
- signal
- timedOut
- aborted
- sandboxDenied
- outputTruncated
- terminationFailed

例如进程在 timeout 竞争中最终返回 exitCode 0，仍应保留 timedOut=true，而不是由单一状态覆盖事实。

### 10.3 输出与 PTY

- 支持 pipe 与 PTY。
- stdin、resize 和 terminate 对同一 Process 串行。
- 输出使用单调 seq/cursor。
- 提供 read(afterSeq, maxBytes, waitMs)。
- 内存 ring buffer 有硬上限。
- 超量输出进入私有 spill，返回截断/省略元数据。
- 慢 UI 不直接持有 Process 管道，必须通过有界 Runtime stream。
- 输出 gap 可从 cursor 补读；无法补读时明确 resync/truncated。

### 10.4 所有权

- 默认前台 Process 属于当前 Turn。
- 只有显式 detach/promote 的 Process 才转移到 Thread。
- 中断 Turn 终止其前台进程树。
- Thread suspend/shutdown 必须处理其后台 Process。
- UI 断开不自动终止 Thread-owned background Process。
- 后台 Process 必须有 TTL、最大存活时间、数量/输出配额和显式 pin；不得永久、无上限地阻止 Thread unload。
- 宿主正常退出默认终止本地 Process；只有外置持久 Process Supervisor 明确提供 reattach 时，才能声明跨 Runtime 存活。

### 10.5 终止协议

1. 标记 terminating，拒绝新 stdin。
2. 发送协作 interrupt/TERM。
3. 等待 grace period。
4. 强制 KILL 整个 process group/Job Object。
5. 等待可观察的 leader、process group 或 Job Object 确认，并 drain 输出。
6. 无法确认整组退出时返回 terminationFailed/unknown。
7. 持久化 terminal outcome。
8. 释放 PTY、文件和 registry entry。

必须验证“kill 后等待可观察对象完成”，不能只调用 kill 即认为清理成功。通用 Node/Unix 环境无法绝对证明已经脱离 group/session 的任意孙进程都消失，因此验收只对受控 process group/cgroup/Job Object 做可验证承诺，其余情况显式报告 unknown。

### 10.6 平台实现

主控制面保持 TypeScript：

- Node child_process/node-pty 负责常规调用和 PTY。
- Unix process group、Windows Job Object、受限 token、平台 Sandbox 放到小型 native helper 或独立 Provider。
- 只有指定 execution/process 包可以导入 child_process、node-pty 或 native binding。
- Runtime Core 不依赖 Node 原生 API，便于测试和未来替换。
- 必须定义宿主异常退出策略：Windows Job Object kill-on-close；Unix 使用受控 process group、parent-death/cgroup 或外置 helper。强杀 Runtime 后的孤儿检查属于 Secure Beta 门。
- 普通 Node Provider 在宿主崩溃后不能声称可以恢复旧句柄；只有外置 Supervisor 提供稳定协议和持久身份时才允许 reattach。

---

## 11. Policy、Approval 与 Sandbox

### 11.1 固定安全链路

~~~text
Tool Plugin
→ ExecutionBroker
→ Host Policy Intersection
→ optional Approval
→ frozen Attempt Fingerprint
→ Sandbox Provider
→ Process Supervisor
→ Outcome
~~~

Sandbox 与 Approval 独立：

- Sandbox 决定操作系统层能做什么。
- Approval 决定何时需要人类确认。
- Policy 决定自动允许、拒绝或请求审批。

### 11.2 权限模型

必须拆成三个独立对象：

- PermissionProfile：允许访问哪些 command、filesystem roots、network targets、IPC capability。
- ResourceLimits：timeout、CPU、memory、process count、output、disk spill 等数量上限。
- ExecutionEnvironment：program/argv、cwd、环境白名单、tty、Sandbox Provider 和平台身份。

三者合并规则不同：

- PermissionProfile 取权限交集，deny 优先。
- ResourceLimits 通常取更小值。
- ExecutionEnvironment 由 Host 选择并冻结，插件不能替换为更宽松环境。
- 插件只能增加限制，不能扩大 Host grant。
- 路径在执行边界规范化，必须处理 symlink/junction。
- 无法解析时 fail closed。
- 网络默认关闭，与文件系统权限独立。
- 网络策略分别处理 DNS、loopback、Unix socket/Windows named pipe、代理和远程 MCP，不能用一个 allowNetwork 布尔值概括。

### 11.3 Approval fingerprint

批准必须绑定：

- threadId/turnId/toolAttemptId。
- 工具 ID。
- 最终 program/argv。
- cwd。
- 环境摘要。
- 可读/可写 roots。
- network。
- sandbox profile。
- expiry 和一次/会话 scope。

任一字段变化后原批准失效。无人控制、审批超时或 controller 断开时默认拒绝。批准后、执行前必须再次解析 executable、PATH、symlink/junction 和 workspace root；若指纹或文件身份改变，重新审批，防止 TOCTOU 替换。

### 11.4 Sandbox 技术路线

纯 TypeScript 不能单独提供 Codex 级 OS 强隔离。建议 ADR 比较三条路线：

| 路线 | 优点 | 代价 | 定位 |
|---|---|---|---|
| TypeScript Runtime + 小型平台 Provider/Native Helper | 主架构保持 TS，边界清晰，可逐平台替换 | 需要平台系统开发与测试 | 默认推荐 |
| codex exec/sidecar 可行性 Spike | 可快速对照部分现有行为 | 不存在可预设为稳定公共 API 的成熟组件；协议、部署和平台覆盖均需验证 | 仅内部实验候选，不进入进度承诺 |
| 纯 Node 路径/命令检查 | 开发快 | 不能抵御 symlink、TOCTOU、子进程和网络逃逸 | 仅 trusted-local UX guard |

默认产品方向：

- 主 Runtime、协议、插件和状态机全部 TypeScript。
- Sandbox 通过稳定接口接入平台 Provider。
- Linux 可考虑 bubblewrap/Landlock。
- macOS 可考虑 Seatbelt。
- Windows 需要 restricted token、Job Object、ACL/网络策略等组合。
- 若强 Sandbox Provider 不支持请求的策略，返回 unsupported 并拒绝执行。
- trusted-local 是宿主显式选择的独立 Profile；Secure Profile 请求的隔离不可用时必须 fail closed，二者不能自动互相降级。

当前开发环境为 Windows。M0 应把“Windows-first 还是 Linux-first”作为正式 ADR：如果首要目标是当前桌面可用性，暂定 Windows-first；如果首要目标是尽快完成安全 Beta，可选择 Linux-first 并在 Windows 同步完成 Process/Job Object 基础。不得在未决策时暗示已经跨平台安全。

### 11.5 发布措辞

- 没有真实 OS enforcement 时，只能称 trusted-local 或 functional preview。
- 至少一个明确目标 OS 的逃逸测试、宿主私有状态隔离和独立安全审查通过后，才可称 Secure Beta；自建测试通过本身不是完整安全背书。
- 目标平台矩阵全部通过后，才可称 Industrial v1。

---

## 12. Protocol、App Server 与多 UI

### 12.1 演进 Pi 现有协议

不另建第二 App Server。直接把 Pi packages/protocol、server、client 演进到 v2：

- 保留 TypeBox/schema-first 设计。
- 生成 TypeScript 类型和 JSON Schema。
- 保留严格请求校验、帧大小上限和 revision 概念。
- 在同一语义上支持不同 transport/codec。

不承诺与 Codex App Server 精确 wire 兼容，只借鉴其生命周期和背压语义。

### 12.2 公共协议原语

- Thread
- Turn
- Step
- Item
- ToolAttempt
- Process
- ApprovalRequest
- Snapshot
- WireEvent/ThreadItem
- LiveEvent

公共协议只暴露版本化 Wire Projection，不直接暴露内部 JournalEnvelope/RuntimeFact。这样 Journal schema 可以演进，而不会把内部事实格式固化给所有 UI。

所有 mutating command 带 clientRequestId，dedupe key 为：

~~~text
(authenticatedClientIdentity, threadId, method, clientRequestId)
~~~

receipt 同时保存 payload hash；同一 key 使用不同 payload 时返回 conflict。分别记录 admission receipt 和最终 result receipt，并设置容量、TTL、归档与恢复策略，防止 dedupe 表无限增长。

### 12.3 初始化与能力协商

连接必须：

1. client 发送 initialize，声明 clientInfo、protocolVersion、capabilities。
2. server 返回选择后的稳定/实验能力。
3. client 发送 initialized。
4. 完成前拒绝其他业务命令。

stable 和 experimental API 分开。未知 client 字段严格拒绝；在兼容版本内，客户端应允许忽略未知 server 字段。

每个连接还有独立 RPC gate：断连后不再启动仍排队的 handler；已经开始的 handler只能有界收尾，并受 controller fencing 和 Thread generation 二次校验。

### 12.4 快速 admission

turn/start 不等待整个 Agent Loop：

~~~json
{
  "turnId": "turn_...",
  "status": "admitted"
}
~~~

后续通过事件发送：

- turn.started
- step.started
- item.started
- item.delta
- item.completed
- turn.completed/interrupted/failed

客户端断连后可以凭 clientRequestId 和 turnId 查询，而不会误判是否启动。

### 12.5 Snapshot、Cursor 与重连

Durable 与 Live 不能承诺同等恢复语义：

- durable cursor：Thread 内严格连续、可重放；watch 原子获得 snapshot、durable watermark 和 watermark 之后的 WireEvent 订阅。
- live epoch/cursor：仅在当前连接/epoch 内 best effort，允许 gap。
- token delta 发生 gap 时，从最终 durable Item snapshot 恢复。
- Process output 使用自己的 seq/cursor/spill，不依赖 Thread live cursor。

若 durable 客户端落后超过保留窗口，返回 resync_required 并获取新 Snapshot。发现 live gap 时发送 liveGap；不得假设 token/process delta 可无限补读。

### 12.6 多 UI 与控制权

- 一个 Thread 可有多个 observer。
- 同一时刻只有一个 server-side controller lease。
- 只有 controller 可以启动/steer/interrupt Turn、修改设置和回答审批。
- lease 明确定义 acquire、renew、release、expiry，并返回单调递增 fencing epoch。
- 每个 mutating command 和 approval response 都携带 lease epoch，在 mailbox admission 和真正副作用边界各校验一次。
- 旧 controller 的排队命令在 lease 转移后必须被拒绝。
- 本项目选择比 Codex 多响应竞争更保守的单 controller 语义：controller 断开或 lease 过期时立即撤销未决审批、发布 requestResolved(controller_lost) 并拒绝当前 Attempt；新 controller 不能回答旧 ApprovalRequest，只能在策略允许时触发新的 request/attempt。
- 每个 ApprovalRequest 位于 pending map，带 requestId、deadline、cancel 和 resolved 状态；resume 时只重放仍属于当前有效 controller epoch 的请求。
- observer 不能通过本地 UI 状态绕过服务端权限。
- UI 从事件重建视图，不直接写 Journal。

### 12.7 背压

- ingress command queue 有界，满时返回稳定 overload 错误。
- 每个连接的 outbound queue 有界。
- 慢客户端被隔离、断开或要求 resync，不能阻塞 ThreadRuntime。
- process output、token delta 和 tool progress 都有独立预算。
- Snapshot 和 durable terminal 可高于可丢弃 live delta，但优先级队列不得让 terminal 越过其依赖的 durable Item，因果顺序必须保持。

### 12.8 Transport

建议顺序：

1. in-process adapter。
2. stdio JSONL。
3. owner-only Unix socket。
4. Windows named pipe。
5. 经过认证的 WebSocket，后续再做。

Pi 现有 CBOR framing 可作为优化 codec 保留，但所有 codec 必须共享完全相同的语义 schema 和 conformance suite。

---

## 13. 推荐目录与依赖边界

### 13.1 不要一开始拆成几十个 npm 包

先保持 Pi 现有包名和发布面，在源码内部建立逻辑模块；只有依赖方向与 API 稳定后，再按需要拆包，避免重现 DSH 的包数量和 Codex 的 crate 复杂度。

建议最终逻辑结构：

~~~text
pi-ds-codex-harness agent/
├─ packages/
│  ├─ ai/                       # 保留 Pi
│  ├─ agent/                    # Pi 低层类型与 agentLoop
│  ├─ journal-core/             # Pi Entry/LaneRecord/Reducer 演进
│  │
│  ├─ plugin-runtime/           # Host/Scope/Effect
│  ├─ plugin-sdk/               # 唯一第三方公共 API
│  ├─ composition/              # Profile/Bundle/Patch
│  │
│  ├─ runtime-core/             # HostLifecycle/ThreadManager/Thread/Turn/Step/Task
│  ├─ pi-agent-driver/          # Pi 事件与工具适配
│  ├─ model-gateway/            # 模型 pre-dispatch、request ID、usage、恢复
│  ├─ tool-runtime/             # pipeline/scheduler
│  │
│  ├─ execution-core/           # ExecutionBroker 接口
│  ├─ workspace-fs/             # 声明式文件动作 Provider
│  ├─ network-runtime/          # 受控网络/MCP Provider
│  ├─ process-node/             # PTY/process supervisor
│  ├─ sandbox-core/             # Policy/Approval/Sandbox contracts
│  ├─ sandbox-windows/          # 按 ADR 建立
│  ├─ sandbox-linux/
│  ├─ sandbox-macos/
│  │
│  ├─ persistence-jsonl/
│  ├─ thread-index-sqlite/
│  ├─ blob-store/
│  │
│  ├─ protocol/                 # 演进 Pi protocol v2
│  ├─ server/                   # 演进 Pi server
│  ├─ client/                   # 演进 Pi client，作为唯一 runtime-client
│  ├─ ui-projections/
│  ├─ coding-agent/
│  └─ tui/
├─ profiles/
│  ├─ minimal/
│  ├─ coding/
│  └─ test/
├─ docs/
│  ├─ adr/
│  ├─ protocol/
│  ├─ source-port-ledger.md
│  └─ threat-model.md
├─ tests/
│  ├─ conformance/
│  ├─ fault-injection/
│  ├─ protocol/
│  ├─ security/
│  └─ soak/
└─ tools/
   └─ architecture-guards/
~~~

初期可把这些作为少数几个包中的子目录；Secure Beta 前建议把公开包数控制在约 8–12 个。

### 13.2 依赖方向

~~~text
CLI / TUI / Future UI
          │
          ▼
runtime-client ─────► protocol
          │
          ▼
server/adapters ────► runtime-core
                         │
       ┌─────────────────┼───────────────────┐
       ▼                 ▼                   ▼
 pi-agent-driver    tool-runtime         journal-core
       │                 │                   │
       ▼                 ▼                   ▼
   Pi agentLoop     ExecutionBroker      Persistence
       │                 │
       ▼                 ▼
 RuntimeModelAdapter   WorkspaceFS / Network / Process + Sandbox Providers
       │
       ▼
  ModelGateway ─────► Model Providers

plugin-runtime/composition 为受控横切层，但不能越过安全微内核
~~~

架构守卫：

- UI/Client 不得依赖 runtime-core 内部目录。
- Runtime Core 不得依赖 TUI、Server transport 或 Node native API。
- Plugin SDK 不得依赖 Cordis。
- Pi agentLoop 只能获得 RuntimeModelAdapter，不能获得裸网络 Model Provider。
- 只有 persistence Provider 可依赖 fs/sqlite writer。
- 只有受控 WorkspaceFS/Network/Process Provider 可直接依赖 fs、网络库、child_process、node-pty 或 native helper。
- Tool Plugin 不得直接导入裸 Process Provider。
- SQLite index 不得反向写 canonical Journal。
- host-private Journal/Blob/IPC 目录不得位于任何 Sandbox writable root。

---

## 14. 源码建立与上游管理策略

### 14.1 新项目建立

M0 建议从固定 Pi commit 建立新目录并保留 Pi 历史：

1. 确认目标目录除本计划外无实现代码。
2. 从 Pi b8b873b... 建立目标 Git 历史。
3. 将本计划和后续 ADR 纳入目标仓库。
4. 增加只读 reference remotes 或本地 commit 记录。
5. 创建 source-port ledger。
6. 运行并保存 Pi baseline test、启动性能和 golden trace。
7. 暂不做全仓品牌改名，先稳定行为和边界。

具体 Git 落地方式应在执行 M0 时根据“是否必须保留当前空目录中的文档提交”选择，不在本报告阶段直接操作源码。

### 14.2 Source-port ledger

每项借鉴记录：

| 字段 | 内容 |
|---|---|
| feature/contract | 要移植的行为 |
| source repo/commit | 来源和固定提交 |
| source paths | 关键文件 |
| strategy | reuse / adapter / rewrite / behavior-only |
| target module | 新实现位置 |
| invariants | 必须保持的性质 |
| conformance tests | 对应测试 |
| status | proposed / in progress / verified |

这样可以区分“复制代码”和“独立重写行为”，并支持未来上游差异审查。

### 14.3 上游同步

- Pi：定期同步低层 model/provider 修复，按变更集 rebase/cherry-pick。
- DSH/Codex：不做全量 merge，只跟踪选定行为契约和测试变化。
- 每次同步先更新 ledger 和兼容性报告，再修改目标代码。
- 任何协议或 Journal schema 变化必须配 migration/compatibility test。

### 14.4 旧原型迁移

旧 pi+ds harness agent 必须先冻结 snapshot。每次只移植一个可验证资产：

1. Plugin DAG/Effect tests。
2. Profile composer。
3. JSONL recovery tests。
4. Pi Driver replay policy。
5. Tool pipeline 原型。

迁移时同步修复已知问题，禁止整目录复制后再清理。

---

## 15. 分阶段执行路线

### 15.1 依赖关系

~~~text
M0 → M1 → M2 → M3
          │     ├──────────────→ M7a
          ├────→ M4 ───────────┐
          └────→ M5 provider ──┤
                  M3 → M5 broker integration

M3 + M4 + M5 + M7a ─────────→ M6
M6 + M7a ────────────────────→ M7b
M3 + M4 + M5 + M6 + M7b ────→ M8 → M9
~~~

M4 与 M5 的 Provider 基础可以在 M2 后并行；M5 的副作用提交集成必须等待 M3 durability barrier。M7 拆为前置租约/协议基础和后置审批集成，消除 M6 与多 UI 审批之间的循环依赖。以下“天”均指人日，不是自然日；阶段合计之外另留 25%–35% 集成缓冲。

### M0：基线冻结与决策门（3–5 人日）

交付：

- 从 Pi 固定提交建立目标代码基线。
- 三仓 commit、source-port ledger、仓库映射。
- Pi 全量 baseline tests。
- Golden trace：纯对话、单 Tool、多 Tool、流式中断。
- 当前启动耗时、内存、包体积基线。
- 统一词汇和“七个唯一”ADR。
- Sandbox 首发 OS 和实现路线 ADR。
- 明确非目标与 release gate。

退出条件：

- Pi 基线测试可重复全绿。
- 目标仓库可独立安装、构建、测试。
- ADR-001、002、003、004、005、007、008、009、011、012 获得确认。
- 未发生大规模重命名或非必要重构。

### M1：契约、状态机与协议骨架（5–8 人日）

交付：

- Thread/Turn/Step/Item/Task/ToolAttempt ID 类型。
- RuntimeHost、HostLifecycleCoordinator、ThreadRuntime、AgentDriver、ModelGateway、ThreadJournalStore、ExecutionBroker、WorkspaceFS/Network/Process/Sandbox Provider 接口。
- 状态转移表和错误分类。
- ModelAttempt/ToolAttempt/ProcessAttempt 与 outcome_unknown 契约。
- Pi protocol v2 schema。
- initialize/capabilities、fenced controller、command dedupe、durable/live cursor envelope。
- Plugin SDK、Service/Scope/Effect conformance skeleton。
- Cordis 3 人日 Spike 并只保留一种方案。
- Threat model 初稿。

退出条件：

- 状态机模型测试覆盖所有合法/非法转移。
- API 不依赖 UI、Cordis 或 Node native。
- schema fixtures 可生成并稳定比较。
- Sandbox unsupported 路径默认拒绝。

### M2：最小纵向 Runtime（8–12 人日）

交付：

- RuntimeHost、ThreadManager、ThreadRuntime。
- HostLifecycleCoordinator 和每个已加载 Thread 的单一 Mailbox。
- 一个 ActiveTurn。
- Pi AgentDriver。
- Fake LLM 通过 FakeModelGateway 接入；纯内存 Fake Tool 使用顺序 ToolBatchScheduler。
- 最小 ExecutionBroker facade；不执行真实 workspace 写入、网络或 Process。
- 最终 ThreadJournalStore API 的 Memory 实现。
- 最终 Plugin API 的最小实现。
- Headless SDK 与 in-process adapter。
- 快速 turn/start admission。
- 两个 observer 同时观看。
- interrupt 与 terminal exactly-once。

验收场景：

~~~text
Prompt
→ Turn admitted
→ Pi model request
→ in-memory Fake Tool proposed/executed
→ second model request
→ final message
→ canonical accepted terminal
→ two observers receive consistent state
~~~

退出条件：

- Prompt→LLM→Tool→LLM→Terminal 全闭环。
- 同一 Thread 永远不出现两个 ActiveTurn。
- 100 次 interrupt/complete 竞争不产生双终态。
- Runtime 可在无 CLI/TUI 情况下嵌入。
- M2 不宣称崩溃耐久性或执行真实外部副作用。

### M3：Durable Journal 与恢复（8–12 人日）

交付：

- 扩展 Pi Entry/LaneRecord envelope。
- Memory 与 JSONL Store conformance。
- append/persist/flush/checkpoint/shutdown/discard。
- accepted/persisted/power-loss durable 三档 receipt。
- writer claim/fence。
- StepSnapshot 和 ModelAttempt。
- Projection 与 Snapshot。
- clientRequestId dedupe receipt。
- torn-tail 与 mid-log corruption 处理。
- incomplete Turn/Model/Tool recovery。
- Blob/spill 引用。
- 最小 SQLite 可重建 Thread Index。

退出条件：

- 在线 canonical durable Projection 与 replay Projection 完全一致。
- 删除 SQLite 后重建查询一致。
- 在每个故障注入点崩溃都得到确定恢复结果。
- 非幂等副作用不会由 replay 自动重放。

### M4：正式插件组合（6–9 人日）

交付：

- 静态 manifest、DAG 和版本约束。
- Runtime/Thread/Turn Scope。
- 托管 Effect、Listener、Timer、Task。
- activate 事务和 LIFO rollback。
- Service seams。
- Durable/Live/Middleware 分域。
- Profile/Bundle/Patch。
- minimal 与 test Profile。
- 旧 Pi Extension compatibility facade。

退出条件：

- 两个 Runtime 实例无交叉污染。
- 任意第 N 个 Effect 失败后资源归零。
- dispose 错误不阻止其余释放。
- 相同输入组合产生相同 Profile manifest hash。
- M2 最小 PluginHost 原地增量通过正式 conformance，不新建第二实现。

### M5：ExecutionBroker 与 Process Runtime（10–15 人日）

交付：

- 固定 Tool Gateway。
- Process opaque ID 和 registry。
- pipe/PTY、stdin、resize。
- output seq/cursor/long-poll。
- ring buffer、spill、截断元数据。
- timeout、interrupt、terminate。
- 前台/后台 Process ownership。
- Unix process group / Windows Job Object 基础。
- TERM→KILL、kill→await。
- Process Provider conformance。
- 宿主崩溃后的 kill-on-close/parent-death/helper 策略。

退出条件：

- 受控 process group/Job Object 终止可确认；无法确认时准确返回 terminationFailed/unknown。
- 输出洪水不突破内存/磁盘预算。
- 超时、exitCode、signal、aborted 等结果独立准确。
- 旧 ProcessId 的晚到事件不能污染新进程。
- Broker 的 write-before-execute 集成测试依赖 M3 完成。

### M7a：协议、连接与 Controller Fencing（6–10 人日，M6 前置）

交付：

- 演进 Pi server/client 的 Protocol v2 基础。
- initialize/initialized/capability。
- Host 生命周期资源级队列。
- Snapshot + durable watermark + watch。
- live epoch/gap/resync。
- controller acquire/renew/release/expiry 和 fencing epoch。
- clientRequestId 命名空间、payload hash 与 dedupe receipt。
- inbound/outbound bounded queues。
- stdio JSONL 与至少一个平台本地 transport。

退出条件：

- 双 observer 的 durable view 一致。
- 旧 controller 的晚到命令在 admission 和执行边界均失败。
- 慢客户端不会拖慢 Runtime。
- 重复 ID 不重复 Turn，同 ID 不同 payload 返回 conflict。

### M6：Policy、Approval 与主平台强 Sandbox

估算：

- Linux 或经验证的成熟隔离 Provider：20–35 人日。
- Windows-first 且从零开发：35–60 人日。
- M0 Spike 后必须重估，不能把该区间视为承诺。

交付：

- Host-owned PermissionProfile。
- 单调 policy intersection。
- Approval request/response/fingerprint/expiry。
- PermissionProfile、ResourceLimits、ExecutionEnvironment。
- 首发平台真实 Sandbox Provider。
- symlink/junction/path traversal/网络逃逸测试。
- unsupported fail-closed。
- 参考 WorkspaceFS、Network、Process Tool 全部经 Broker。
- host-private Journal/Blob/IPC 隔离和宿主崩溃清理。

退出条件：

- denied/expired/disconnected 的 execute count 始终为 0。
- 修改 argv/cwd/roots 后无法复用批准。
- 强 Sandbox 逃逸套件全部通过。
- 不存在静默 unsandboxed fallback。
- controller fencing、Approval fingerprint 和 TOCTOU 二次校验通过。
- Secure Beta 只声明经过独立审查的明确平台能力。

### M7b：Approval、多 UI 与 App Server 集成（5–8 人日）

交付：

- Approval server request。
- pending request map、deadline、cancel 和 requestResolved。
- controller 丢失后的 fail-closed 语义。
- 快速 admission、dedupe、overload 的端到端集成。
- Protocol 诊断客户端；产品 CLI/TUI 留给 M8。

退出条件：

- 双 UI 观察一致。
- controller 竞争、断线、审批撤销和转移结果确定。
- 未决 Approval 只接受当前 fencing epoch。
- schema fixture 和 transport conformance 全绿。

### M8：Coding Profile 与产品迁移（15–25 人日）

交付：

- Read/Write/Edit/Shell 等 coding tools。
- Skills/Prompt contributors。
- Compaction。
- Pi CLI/TUI 改为 Runtime Client。
- coding Profile。
- Pi Extension facade。
- 常见 coding workflow golden tests。
- 文档、样例和嵌入 API。

退出条件：

- 常见 Coding Agent 工作流达到 Pi 基线等价或更好。
- 所有 Agent 发起的 Read/Write/Edit/Shell/Network Tool 动作均通过受控 Provider 和 Broker。
- TUI、CLI、Headless SDK 共用同一 Thread。
- Compaction 后 model-visible context 可解释和恢复。

### M9：可靠性、跨平台与发布（40–80+ 人日，另计长稳自然时间）

交付：

- 故障注入全矩阵。
- 状态机属性测试。
- Protocol fuzz。
- 长时 soak 和随机取消。
- 性能预算优化。
- 第二、第三平台 Sandbox。
- Plugin SDK 兼容策略。
- schema migration 与 release tooling。
- 运行手册、故障恢复手册和安全声明。

退出条件：

- 目标 OS 矩阵通过。
- 数千 Turn soak 无资源增长和状态分叉。
- 恶意/慢客户端不破坏 Runtime。
- 发布说明准确标注安全边界与未支持能力。

---

## 16. 首批工作包/Issue 大纲

### 架构与基线

- E0-01：从 Pi 固定提交建立目标历史。
- E0-02：Pi baseline test 和 golden trace。
- E0-03：统一词汇/身份 ADR。
- E0-04：唯一 Journal/Runtime/Loop ADR。
- E0-05：首发 OS 与 Sandbox 路线 ADR。
- E0-06：source-port ledger 和上游同步流程。

### Runtime 合同

- E1-01：Branded IDs 与 schema。
- E1-02：Thread/Turn/Step/Task 状态机。
- E1-03：HostLifecycleCoordinator 与 LoadedThreadMailbox。
- E1-04：AgentDriver 接口和 FakeDriver。
- E1-05：RuntimeModelAdapter、ModelGateway 和 pre-dispatch barrier。
- E1-06：ThreadJournalStore/Writer 与三档 durability receipt。
- E1-07：ExecutionBroker/WorkspaceFS/Network/Process/Sandbox 接口。
- E1-08：ModelAttempt/ToolAttempt/ProcessAttempt 和 outcome_unknown。
- E1-09：command dedupe、controller fencing 与 runtimeGeneration。

### 纵向切片

- E2-01：ThreadManager/ThreadRuntime。
- E2-02：PiAgentDriver 与事件翻译。
- E2-03：Memory Journal 与 Projection。
- E2-04：纯内存 Fake Tool、最小 Broker facade 和顺序 Scheduler。
- E2-05：快速 Turn admission。
- E2-06：Abort/terminal race。
- E2-07：双 observer。

### 持久化

- E3-01：versioned Journal envelope。
- E3-02：JSONL writer 和 durability barrier。
- E3-03：writer lease/fence。
- E3-04：torn-tail/corruption。
- E3-05：StepSnapshot。
- E3-06：Model/Tool incomplete recovery。
- E3-07：Blob/spill。
- E3-08：SQLite rebuildable index。

### 插件与组合

- E4-01：Cordis vs self-host Spike。
- E4-02：Manifest/DAG。
- E4-03：Scope/Effect。
- E4-04：事务内 defer/use/listen/task 和 activate rollback。
- E4-05：Service API。
- E4-06：Profile/Bundle/Patch。
- E4-07：Pi Extension facade。

### 执行与安全

- E5-01：Tool Pipeline。
- E5-02：Process registry/opaque IDs。
- E5-03：PTY/stdin/resize。
- E5-04：Output cursor/spill。
- E5-05：受控 Process group/Job Object 终止和宿主崩溃策略。
- E5-06：WorkspaceFS/Network 声明式 PreparedAction。
- E6-01：PermissionProfile intersection。
- E6-02：Approval fingerprint。
- E6-03：首平台 Sandbox Provider。
- E6-04：Sandbox escape suite。
- E6-05：trusted-local 与 secure mode 明确分离。
- E6-06：host-private Journal/Blob/IPC 与 TOCTOU 二次校验。

### 协议与产品

- E7-01：Protocol v2 schema。
- E7-02：initialize/capabilities。
- E7-03：durable snapshot/watch 与 live gap/resync。
- E7-04：controller lease acquire/renew/release/expiry/fencing。
- E7-05：backpressure/overload。
- E7-06：stdio/local transport。
- E7-07：pending Approval request 和 requestResolved。
- E8-01：Coding Profile。
- E8-02：CLI/TUI Runtime Client 化。
- E8-03：Compaction 和恢复。
- E8-04：文档/样例。

每个 Issue 都必须包含：状态机影响、durable/live 影响、安全边界、故障注入点、验收测试和 source-port ledger 链接。

---

## 17. 测试与质量计划

### 17.1 Conformance Suites

所有实现共享同一套：

- PluginHost conformance。
- ThreadJournalStore conformance。
- AgentDriver lifecycle conformance。
- ModelGateway pre-dispatch/recovery conformance。
- ToolBatchScheduler/Tool Provider conformance。
- WorkspaceFS/Network Provider conformance。
- Process Provider conformance。
- Sandbox Provider escape conformance。
- Protocol Transport/Client conformance。

核心测试必须使用 Fake LLM/Fake Process/Fake Sandbox 离线运行，不能依赖真实模型稳定性。

### 17.2 故障注入矩阵

| 区域 | 故障 | 通过标准 |
|---|---|---|
| Plugin | 第 N 个 Effect 激活后抛错 | LIFO 回滚，Service/Listener/Timer/Task 数量归零 |
| Plugin | dispose 抛错或重复 dispose | 继续释放其余资源，最终聚合错误 |
| Plugin | middleware 阻塞 JS event loop | 在隔离测试进程验证风险；Secure Profile 不加载不可信同进程 middleware，长任务进入 Worker/独立进程并由宿主超时 |
| Turn | 100 个并发 start/steer | 最多一个 ActiveTurn，其余明确 queue/reject/steer |
| Turn | interrupt 与 complete 同时发生 | 只产生一个 terminal fact |
| Lifecycle | 旧 runtimeGeneration 延迟 teardown | compare-and-remove 不影响新 Runtime |
| Store | dispatch_intent flush 前失败 | Tool/Model body 执行次数为 0 |
| Store | append 成功、publish 前崩溃 | Replay 可见事实，eventId 去重 |
| Store | 磁盘满或 fsync 失败 | 不越过副作用/terminal barrier，进入 degraded/faulted |
| Store | Blob 成功、Journal 引用失败 | Blob 进入可回收 orphan，不出现悬空 Journal 引用 |
| Store | JSONL 尾行截断 | 恢复到最后完整记录 |
| Store | JSONL 中段损坏 | fail corruption |
| Index | 删除 SQLite | 从 JSONL 重建后结果一致 |
| Model | dispatch_intent 后各点崩溃 | 不静默重复请求/计费；reconcile 或 outcome_unknown |
| Tool | dispatch_intent 后、Provider receipt 前崩溃 | 保守 unknown；仅有未启动证明时重试 |
| Tool | body 完成、result 写入前崩溃 | outcome_unknown，非幂等不重试 |
| Tool | parallel 完成乱序 | result 按完成顺序持久化，模型结果按 callIndex |
| Approval | 无 UI、断线、超时 | 拒绝且 execute count 为 0 |
| Approval | 修改 argv/cwd 后复用决定 | fingerprint 不匹配 |
| Approval | 批准后 executable/PATH/symlink 被替换 | 执行边界二次校验失败并重新审批 |
| Sandbox | Provider 不支持策略 | 明确 unsupported，不执行 |
| Sandbox | symlink/junction/path traversal | 无法越过授权根 |
| Sandbox | network 默认关闭 | DNS/TCP/本地 socket 按策略阻断 |
| Sandbox | Tool 修改 Journal/Blob/IPC endpoint | host-private 边界阻断 |
| Process | 子进程生成孙进程 | 受控 group/job 可确认退出；否则 terminationFailed/unknown |
| Process | 强杀 Runtime 宿主 | kill-on-close/parent-death/helper 策略不留未管理孤儿 |
| Process | TERM 被捕获 | 宽限后 KILL，最终 done |
| Process | timeout 后 exitCode 0 | 同时保留 timedOut 和 exitCode |
| Process | 100MB 输出 | 内存不突破预算，spill/truncation 正确 |
| Process | 旧 ID 晚到事件 | 不污染新 Process |
| Protocol | 重复 clientRequestId | 同 principal/thread/method/payload 返回原 receipt，不重复副作用 |
| Protocol | 同 request ID、不同 payload/principal | 明确 conflict，不复用 receipt |
| Protocol | 旧 controller 在租约转移后发命令 | admission 和执行边界均因 fencing 失败 |
| Protocol | 慢客户端 | 被隔离/resync，Runtime 不阻塞 |
| Protocol | Durable Snapshot/订阅竞态 | durable watermark 后无缺失、无重复 |
| Protocol | Live queue 丢包 | 发 liveGap，用 durable Item/独立 Process cursor 降级恢复 |
| Protocol | 未 initialize/未知 capability | 稳定协议错误 |
| Config | Step 运行中切换模型/权限 | 当前 Step 不变，仅影响后续安全边界 |
| Shutdown | Tool、审批、后台进程同时存在 | 停止接纳、取消、可验证终止、flush、释放并输出 completed/failed/timedOut 报告 |

### 17.3 属性测试与 Fuzz

- 状态机任意命令序列始终保持唯一 ActiveTurn 和唯一 terminal。
- 任意事件前缀 replay 不执行副作用。
- Event encoder/decoder round-trip。
- JSONL 随机截断与 bit flip。
- Protocol framing、长度、未知字段、乱序响应、重复 ID。
- Tool scheduler 在随机完成顺序下保持模型提交顺序。
- Scope 随机 activate/dispose 始终无资源残留。

### 17.4 性能与长稳

M0 记录 Pi 基线，后续用相对指标控制。初始建议：

- minimal Profile 冷启动相对 Pi 回退不超过 20%，最终以实测调整。
- 空闲 Thread 可卸载，恢复不丢事件。
- 每个 queue、buffer、output、blob、prompt fragment 均有硬上限。
- 数千 Turn 随机取消 soak 无持续内存、句柄或子进程增长。
- 慢 observer 不影响另一个 observer 和 Runtime。

### 17.5 安全测试

- 路径 traversal、symlink、junction、mount/reparse point。
- 环境变量泄漏。
- shell 注入；普通命令必须使用 argv，只有显式 Shell Tool 接受 shell string。
- DNS、loopback、代理、本地 IPC、远程 MCP 分项默认拒绝和独立授权。
- 子进程逃逸、宿主强杀和受控进程组清理。
- Approval token 重放、过期、跨 Turn/Attempt 使用。
- Approval 后 executable/PATH/symlink 替换的 TOCTOU。
- 插件尝试扩大权限。
- Tool 尝试读取或改写 host-private Journal、Blob、lock、IPC endpoint。
- 日志/错误/trace 的 secret redaction。
- unsupported Sandbox fail-closed。

---

## 18. 风险清单与控制

| 风险/反模式 | 等级 | 控制措施 |
|---|---:|---|
| AgentHarness 与 ThreadRuntime 同时做总协调器 | P0 | AgentHarness 仅做 facade，ThreadRuntime 唯一所有者 |
| Pi、DSH、Codex 三套日志并存 | P0 | 只演进 Pi Journal，其他只移植语义 |
| Thread 生命周期队列与已加载邮箱混成一层 | P0 | HostLifecycleCoordinator 与 LoadedThreadMailbox 分离 |
| Pi Tool scheduler 与 ToolRuntime 重复调度 | P0 | 抽出唯一 ToolBatchScheduler seam |
| Pi Loop 直接调用裸 Model Provider | P0 | 只注入 RuntimeModelAdapter；ModelGateway 在 dispatch 前提交并 flush intent |
| Tool 绕过 ExecutionBroker | P0 | Secure Profile 只接受声明式 PreparedAction；同进程任意插件明确属于 TCB |
| “一切皆插件”允许替换安全裁决 | P0 | 对第一方 API 保持安全微内核；任意同进程代码不在强隔离声明内 |
| Model dispatch 后崩溃导致重复调用/计费 | P0 | ModelAttempt、Provider requestId、reconcile/outcome_unknown |
| body 开始后自动重试非幂等命令 | P0 | outcome_unknown + reconciliation |
| 存储失败转成普通 Tool Error | P0 | 基础设施错误终止 Turn |
| UI 成为第二权威状态 | P0 | UI 仅消费 Snapshot/Event |
| Journal envelope/facade 形成第二套物理日志 | P0 | ThreadJournalStore 明确演进 Pi SessionStorage，每 Thread 唯一 backend |
| 最后 UI 断开即 dispose Thread | P0 | Resource lease/pin；后台资源有 TTL/配额和延迟卸载 |
| 后台进程和 Turn cancellation 混淆 | P0 | foreground 属于 Turn，background 显式提升到 Thread |
| 宿主崩溃留下孤儿进程 | P0 | Job kill-on-close、process group/cgroup/helper 和强杀测试 |
| Agent 可改写 Journal/IPC | P0 | host-private 目录、owner-only ACL、Sandbox 不可达 |
| Controller 转移后旧命令仍生效 | P0 | 单调 fencing epoch，在 admission/执行边界二次校验 |
| 把 live gap 当作可重放 durable stream | P0 | durable cursor 与 live epoch 分离 |
| 宣称纯 Node 即强 Sandbox | P0 | 真实 OS enforcement 或明确 trusted-local |
| Sandbox denial 被当作安全重试依据 | P0 | 仅 Broker 证明未启动才重试 |
| Cordis 类型泄漏公共 SDK | P1 | 私有 adapter，自有 Plugin API |
| Cordis Host 与自研 Host 长期双轨 | P1 | 3 人日 Spike 后删除未采用实现 |
| 复制 DSH 包数量 | P1 | 初期逻辑模块，Beta 前公开包约 8–12 个 |
| 复制 Codex 巨型 core | P1 | 强依赖边界；模块超出约 500–800 行触发拆分审查 |
| 追求 Codex 协议兼容 | P1 | 自有 Protocol v2，只借鉴语义 |
| 热更新污染当前 Step | P1 | StepSnapshot；仅安全边界更新 |
| token/process delta 全量持久化 | P1 | Live stream；最终事实和 spill ref 持久化 |
| 初期全仓改名 | P2 | 先保留 Pi 包名，行为稳定后迁移品牌 |
| 上游频繁漂移 | P1 | 固定 commits、ledger、单独同步变更 |
| schema migration 不完整 | P1 | versioned envelope、fixture、migration test |
| Windows 强 Sandbox 工期低估 | P0 | M0 Spike、明确平台门、保留 Provider 替换能力 |

---

## 19. 发布门与完成定义

### 19.1 Functional MVP

范围对应 M0–M4 加 M7a。

必须：

- 目标仓库以固定 Pi commit 为基线。
- Pi 低层测试保持通过。
- 一个 Prompt→纯内存 Fake Tool→模型→Terminal 闭环。
- 快速 admission、abort、两个 observer。
- Plugin DAG、Scope、Effect 和 rollback。
- Memory 与 JSONL 通过同一 conformance；每个 Thread 只选择一个 canonical backend。
- Replay 与在线 canonical durable Projection 相等。
- 每 Turn 恰好一个 terminal。
- 一个 Runtime、一个 Agent Loop、一个 ModelGateway、一个 Journal。
- Headless in-process SDK。
- 协议 v2 基本身份、durable/live cursor、dedupe 和 controller fencing。

允许：

- 宿主显式选择独立 trusted-local Profile 做开发验证。
- Sandbox Provider 尚处实验阶段。

禁止：

- 宣传强安全或工业级 Sandbox。
- 在 Functional MVP 的安全声明内执行真实 workspace 写入、网络或 Process。

### 19.2 Secure Beta

范围对应 M5、M6、M7b，并且只声明一个明确 OS。

必须：

- Managed Process/PTY、输出限流、受控 group/job 终止确认或明确 unknown。
- 固定 Tool Gateway 和 ExecutionBroker。
- WorkspaceFS、Network、Process 参考 Tool 全部提交声明式 PreparedAction。
- Approval fingerprint 与 controller fencing。
- 首发 OS 真实强 Sandbox。
- unsupported fail-closed。
- Model/Tool/Process 崩溃恢复和 outcome_unknown。
- host-private Journal/Blob/IPC 与宿主强杀后的进程清理。
- 双 UI 与背压。
- 完整 fault injection、escape suite 和独立安全审查。

### 19.3 Industrial v1

范围对应 M8、M9，并明确目标 OS 矩阵。

必须：

- 目标平台矩阵通过。
- CLI/TUI/Headless/未来 UI 共用同一 Runtime 语义。
- 长稳、Fuzz、属性测试和故障注入达到发布门。
- Plugin SDK/Protocol/Journal schema 有兼容策略。
- 恢复、迁移、诊断和安全文档完整。
- 所有产品声明与实际平台能力一致。
- 如果允许第三方不可信插件，必须使用 Worker/独立进程/MCP capability 隔离；否则产品文档明确只支持 TCB 插件。

---

## 20. 必须先写的 ADR

建议编号：

1. ADR-001：三仓固定基线与上游同步。
2. ADR-002：统一领域词汇与 ID。
3. ADR-003：ThreadRuntime 是唯一协调器，AgentHarness 是 facade。
4. ADR-004：Pi Journal 是唯一 canonical log。
5. ADR-005：accepted/persisted/power-loss durable 与 Durable/Live/Middleware/Wire 边界。
6. ADR-006：Protocol v2 与 capability negotiation。
7. ADR-007：HostLifecycleCoordinator、LoadedThreadMailbox 与 runtimeGeneration。
8. ADR-008：controller fencing、command admission、dedupe 与 queue policy。
9. ADR-009：ModelGateway、ModelAttempt/ToolAttempt、pre-dispatch barrier、重试和 outcome_unknown。
10. ADR-010：Process ownership、PTY、output cursor 与宿主崩溃策略。
11. ADR-011：Sandbox 平台与 native helper/sidecar 可行性路线。
12. ADR-012：安全微内核、WorkspaceFS/Network/Process Provider 与同进程 TCB 边界。
13. ADR-013：Cordis adapter 或自研 PluginHost。
14. ADR-014：StepSnapshot 与配置更新边界。
15. ADR-015：JSONL canonical、SQLite rebuildable index。
16. ADR-016：host-private Journal/IPC、Blob、spill 与敏感数据策略。
17. ADR-017：source-port ledger。
18. ADR-018：公共包边界与架构守卫。

其中 ADR-002、003、004、005、007、008、009、011、012 未冻结前，不应开始大规模实现。

---

## 21. 建议的前两周执行安排

### 第 1 周：M0

第 1–2 天：

- 从 Pi 固定提交建立目标代码基线。
- 保存三仓提交、测试环境和 source-port ledger。
- 跑 Pi baseline tests。
- 录制四条 golden trace。

第 3–4 天：

- 冻结统一词汇。
- 冻结一个 Runtime/Loop/Journal/Broker/Plugin API/Protocol。
- 冻结 Host 生命周期队列、LoadedThreadMailbox 和 controller fencing。
- 完成 initial threat model。
- 评估 Windows-first 与 Linux-first。

第 5 天：

- 通过 M0 ADR。
- 固定 Functional MVP、Secure Beta、Industrial v1 的发布措辞。
- 建立 CI、conformance 目录与架构守卫骨架。

### 第 2 周：M1 起步

- 定义 Branded IDs、可判别 Journal envelope、错误联合类型。
- 写 Thread/Turn/ModelAttempt/ToolAttempt 状态转移表。
- 建立 RuntimeHost/HostLifecycleCoordinator/ThreadRuntime/AgentDriver/ModelGateway/Journal/Broker 接口。
- 升级 Protocol v2 schema skeleton。
- 并行执行 Cordis 3 人日 Spike。
- 先写模型测试和 fixtures，再实现最小 ThreadRuntime。

两周结束应获得“可以开始纵向实现”的稳定合同，而不是大量半成品功能。

---

## 22. 最终建议

本项目应坚持以下一句话架构：

> 以 Pi 的 agentLoop 作为轻量执行核心，以 DSH 的 Plugin/Service/Scope/Effect 作为组合平面，以 Codex 的 Thread/Turn/Task/Process/Persistence/Protocol 行为契约作为工业 Runtime；模型请求经过唯一 ModelGateway，Agent 发起的 effectful Tool 动作经过唯一 ExecutionBroker，所有可恢复事实进入唯一 Pi-derived Journal。

最先实现的不是 Shell、TUI 或大量插件，而是：

1. 固定术语与身份。
2. 固定唯一状态机和唯一事实源。
3. 固定 Tool 副作用边界。
4. 做出最小纵向闭环。
5. 用故障注入证明持久化与取消语义。
6. 再并行扩展 Plugin、Process、Sandbox 和多 UI。

这样才能同时保住 Pi 的“干净和易嵌入”、DSH 的“可组合和可扩展”，并真正获得 Codex Harness 的“稳定执行 Runtime”，而不把 Rust 复杂度和产品历史包袱一起带入。

---

## 附录 A：首轮重点源码索引

### Pi

- packages/ai/src/types.ts
- packages/ai/src/models.ts
- packages/ai/src/utils/event-stream.ts
- packages/agent/src/types.ts
- packages/agent/src/agent-loop.ts
- packages/agent/src/agent.ts
- packages/agent/src/harness/agent-harness.ts
- packages/agent/src/harness/session
- packages/agent/src/harness/reducer.ts
- packages/protocol
- packages/server
- packages/client
- packages/coding-agent/src/core/extensions

### DeepSeek Harness

- vendor/cordis/src/context.ts
- vendor/cordis/src/events.ts
- vendor/cordis/src/fiber.ts
- vendor/cordis/src/registry.ts
- vendor/cordis/src/service.ts
- packages/core/scope
- packages/core/agent
- packages/core/agent-loop
- packages/core/tools
- packages/core/session
- packages/boot/app-boot/src/profile.ts
- packages/bundle/base/cordis.patch.yml
- packages/llm/llm-pi-ai

### Codex

- codex-rs/protocol/src/protocol.rs
- codex-rs/core/src/thread_manager.rs
- codex-rs/core/src/session
- codex-rs/core/src/state/turn.rs
- codex-rs/core/src/tasks
- codex-rs/core/src/tools/orchestrator.rs
- codex-rs/core/src/tools/router.rs
- codex-rs/core/src/tools/registry.rs
- codex-rs/core/src/tools/parallel.rs
- codex-rs/core/src/unified_exec
- codex-rs/sandboxing
- codex-rs/thread-store
- codex-rs/rollout
- codex-rs/app-server
- codex-rs/app-server-protocol
- sdk/typescript

## 附录 B：报告结论状态

截至本报告编制时：

- 已完成三套本地源码的只读基线与架构复核。
- 已确认 Codex 源码在本地，可直接用于后续行为对照。
- 已识别旧 Pi+DSH 原型，但未将其脏工作树状态当作完成成果。
- 尚未向新目标目录迁移 Pi 源码。
- 尚未实现任何 Runtime、Plugin、Process、Sandbox 或 Protocol v2 代码。
- 下一步应从 M0 开始，而不是沿用旧报告的完成里程碑。

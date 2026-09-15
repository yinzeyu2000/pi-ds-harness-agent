# pi+ds harness agent：执行报告与开发计划大纲

> 状态：架构规划 v0.1
> 日期：2026-09-02
> 目标目录：`pi+ds harness agent/`

## 0. 执行摘要

`pi+ds harness agent` 应采用“Pi 内核 + DeepSeek Harness 组合层”的路线，而不是直接合并两个仓库：

- 以 Pi 当前代码为唯一基线，保留它的模型层、轻量 Agent Loop、消息/工具协议、TUI 与嵌入能力。
- 完成并扩展 Pi 已存在但尚未完成的 `AgentHarness v2`，复用它的 Entry、LaneRecord、Reducer、JSONL 和 SQLite 契约。
- 在 Pi 外围增加 DeepSeek Harness 风格的插件内核：Service、Provider、Consumer、作用域、依赖注入、可逆 Effect、插件卸载和组合配置。
- 只保留一个 Agent Loop、一个 Session 事实源和一套正式插件 API。
- 默认 `minimal` Profile 必须保持 Pi 的轻量体验；复杂能力通过插件和 Bundle 按需增加。

最关键的成功标准：

> 卸载全部可选插件后，它仍然是一个干净、易嵌入的 Pi；逐步装载插件后，它可以成长为 DeepSeek Harness 风格的可组合平台，而且始终只有一条运行主链和一个持久化事实源。

不建议把 DeepSeek Harness 的数百个包、完整 Loader/HMR、Web/BFF、Typert、PTC、Workflow 等整体搬入新项目。首版应移植架构约束，而非复制整套产品复杂度。

按当前要求，本报告暂不把许可证审查作为技术实施的阻塞项；它不包含发布前的法律、商标和第三方代码清单工作。若项目进入公开分发或商业部署，应另设发布合规阶段。

## 1. 基线快照与源码判断

### 1.1 Pi 基线

- 仓库：`earendil-works/pi`
- 分支：`main`
- Commit：`b8b873b9872db04a938fb4357b5e8e824ddc051c`
- 描述：`v0.84.4-11-gb8b873b98`

应保留的稳定边界：

- `packages/ai`：模型、Provider、流式响应、模型注册表。
- `packages/agent/src/types.ts`：消息、工具和事件类型。
- `packages/agent/src/agent-loop.ts`：轻量 Agent 执行循环。
- `packages/agent/src/agent.ts`：状态、订阅、abort、steer/follow-up。
- `packages/agent/src/harness/session/*`：事件溯源 Session、Storage 与投影基础。
- `packages/session-backends/sqlite-node`：SQLite Session 后端。
- `packages/tui`、`packages/protocol`、`packages/client`、`packages/server`：现有产品和远程接口基础。

重要现状：Pi 当前已经有 `AgentHarness v2` 设计，但它仍是脚手架。

- `packages/agent/src/harness/agent-harness.ts` 中的 `prompt`、`resume`、`compact`、`abort`、`hooks`、`events`、`watch`、`lanes` 等仍返回 `HarnessNotImplemented`。
- 对应测试名就是 `packages/agent/test/harness/agent-harness-scaffold.test.ts`。
- SessionStorage、Entry/LaneRecord、JSONL、SQLite、Reducer 和一致性测试已经有较好的基础。

因此，新项目不能把 `AgentHarness` 当成已完成能力，但应把它的数据模型和公开目标作为首选演进方向。

### 1.2 DeepSeek Harness 参考基线

- 仓库：`deepseek-ai/deepseek-harness`
- 分支：`master`
- Commit：`4e84901e6471b79ec0338099867ebb4606d12bb5`
- 标签：`dsh-v0.1.2-alpha.4`

应重点吸收：

- Cordis 的 Context、Service、Plugin Fiber、依赖注入和可逆 Effect。
- Service Definition → Provider → Consumer 的能力 seam。
- Durable Session、Live Agent、Capability Middleware 三种事件域。
- Append-only Session Log 与纯函数 Projection。
- 工具的 pre / guard / around / body / post / result 固定流水线。
- Profile、Bundle、Patch 的确定性组合模型。
- Agent 创建事务与反向销毁顺序。

直接先例：DeepSeek Harness 已通过 `packages/llm/llm-pi-ai` 将 Pi 模型层作为 LLM Provider 接入。这证明“保留 Pi 模型层、在外围增加 Harness”是可行路线。

## 2. 项目定位

### 2.1 一句话定位

一个可嵌入、可组合、可回放的 TypeScript Agent Harness：默认像 Pi 一样轻量，按需组合后具备 DeepSeek Harness 风格的平台能力。

### 2.2 目标用户

1. 嵌入方：几行代码创建 Runtime，不依赖 CLI、TUI、本地磁盘或 Node 专属能力。
2. 插件作者：通过稳定的 Service、Event、Tool、Prompt 和 Session API 扩展能力。
3. 产品组装者：通过 Profile/Bundle 构建 Coding、Headless、SDK 或其他垂直 Agent。

### 2.3 MVP 目标

- 保持 Pi 原始 Agent Loop 的可读性与低接入成本。
- 支持静态插件发现、依赖解析、启动、停止和无残留卸载。
- 支持 global → agent 两层作用域。
- 用户消息、模型结果、工具调用/结果和关键配置可从日志完整重建。
- Provider、工具、Prompt、持久化、审批策略可以替换。
- CLI 与 Headless SDK 使用同一个 Runtime。
- 具备 `minimal` 和 `coding` 两个可重复组合的 Profile。

### 2.4 MVP 明确非目标

- 不对齐 DeepSeek Harness 的全部包和 API。
- 不重写 Pi 的全部 UI、Provider 和 Agent Loop。
- 不首发 HMR、运行中插件热替换和自动安装。
- 不首发 Web UI、BFF、Python SDK、Typert 或 PTC/run_code。
- 不首发不可信插件沙箱、分布式 Agent、远程多主机调度。
- 不首发 LSP、DAP、浏览器、桌面控制、长期记忆与通用 RAG。
- 不首发完整 Agent Teams、Worktree 编排或通用图工作流。
- 不在 MVP 阶段承诺插件 API 1.0 稳定。

## 3. 总体架构原则

1. **Pi 是执行底座**：模型层与轻量 Agent Loop 优先通过适配器组合，避免直接侵入。
2. **只有一个事实源**：Pi Entry/LaneRecord 演进为唯一 canonical log；不能再建立一套 DSH Session Log。
3. **模型可见即能重建**：进入正式模型请求的历史、上下文、模型路由、系统提示词和工具集合必须有可恢复来源。
4. **持久事实先写后发布**：Append 成功后才能通知 UI、插件或查询投影。
5. **所有插件贡献可逆**：Service、工具、Prompt、监听器、Timer 和后台任务都由 Scope 持有并自动释放。
6. **只有一个正式插件 API**：Pi 旧 Extension API 通过兼容适配器接入，不能形成第三套注册体系。
7. **一个具体 Agent Loop**：默认 Driver 包装 Pi Agent Loop；插件可以替换 Driver，但一个 Agent 实例只能选择一个。
8. **临时视图不污染历史**：Prompt/Context Hook 的临时改写不自动成为持久事实。
9. **拒绝是单调的**：安全 Guard 一旦 Deny，后续插件不能重新 Allow。
10. **执行可并发，提交有顺序**：工具可以并行执行，但结果按模型原始 Tool Call 顺序写入日志并返回模型。
11. **内核与产品分离**：Core 不依赖 CLI、TUI、SQLite、Node 文件系统或具体 Coding Tool。
12. **先纵向闭环再扩功能**：每个阶段必须形成可运行、可恢复、可离线测试的闭环。

## 4. 目标架构

```text
┌───────────────────────────────────────────────────────────────┐
│ Products                                                      │
│ CLI / TUI / Headless SDK / RPC adapter                        │
└──────────────────────────────┬────────────────────────────────┘
                               │
┌──────────────────────────────▼────────────────────────────────┐
│ Composition                                                    │
│ Profile → Bundle → resolved plugin manifest                   │
└──────────────────────────────┬────────────────────────────────┘
                               │
┌──────────────────────────────▼────────────────────────────────┐
│ Plugin Runtime                                                 │
│ Service tokens / dependency graph / scopes / effects / events │
└───────────────┬───────────────────┬────────────────────────────┘
                │                   │
┌───────────────▼──────────┐  ┌─────▼───────────────────────────┐
│ Harness Runtime          │  │ Capability Plugins              │
│ Agent registry/driver    │  │ LLM / tools / prompt / fs       │
│ Turn/Step coordination   │  │ shell / approval / compaction   │
└───────────────┬──────────┘  └───────────────┬────────────────┘
                │                              │
┌───────────────▼──────────────────────────────▼────────────────┐
│ Pi Core                                                        │
│ pi-ai / Agent / agentLoop / message and tool contracts        │
└──────────────────────────────┬────────────────────────────────┘
                               │
┌──────────────────────────────▼────────────────────────────────┐
│ Canonical Session                                              │
│ Entry + LaneRecord → Memory/JSONL/SQLite → Projections         │
└───────────────────────────────────────────────────────────────┘
```

### 4.1 不可插件化的最小内核

“一切皆插件”不能允许可靠性不变量被插件绕过。以下能力属于微内核：

- ID、sequence、schemaVersion、correlation 和事件信封。
- Append 顺序与 write-before-publish。
- 插件 Scope、启动/停止、取消和资源回收。
- Service 冲突、依赖缺失、循环依赖检测。
- Tool 副作用之前不可绕过的 Guard 执行点。
- 一个 Turn 只能有一个终态。
- Canonical Log 的唯一写入边界。

### 4.2 可插件化能力

- LLM Provider 与模型注册表。
- AgentDriver，默认实现为 Pi Agent Loop。
- Tool Catalog 与具体工具。
- Prompt/Context Contributor。
- Compaction 策略。
- Approval 策略。
- FileSystem、ProcessRunner 和 SessionStorage Provider。
- CLI、TUI、SDK、RPC 等产品入口。

## 5. 建议目录结构

内部包名使用无空格 slug；用户指定的顶层目录保持不变。

```text
pi+ds harness agent/
├─ package.json
├─ package-lock.json
├─ tsconfig.json
├─ UPSTREAM_BASELINE.md
├─ docs/
│  ├─ architecture.md
│  ├─ event-model.md
│  ├─ plugin-authoring.md
│  ├─ source-port-ledger.md
│  └─ adr/
├─ profiles/
│  ├─ minimal.json
│  └─ coding.json
├─ packages/
│  ├─ ai/                         # Pi 基线，尽量少改
│  ├─ agent/                      # Pi Agent + Harness 契约
│  ├─ tui/                        # Pi 基线
│  ├─ telemetry/                  # Pi 基线
│  ├─ protocol/                   # 后续适配
│  ├─ plugin-runtime/             # 新增：公开插件 API 与宿主
│  ├─ cordis-adapter/             # 可选：Cordis 私有实现适配
│  ├─ harness-runtime/            # 新增：唯一组合根
│  ├─ pi-agent-driver/            # 新增：默认 Driver
│  ├─ session-projections/        # 新增：纯函数读模型
│  ├─ profile-runtime/            # 新增：Profile/Bundle/Patch
│  ├─ plugin-sdk/                 # 新增：对第三方稳定导出
│  ├─ plugins/                    # 内置逻辑插件，早期不必每个发布
│  │  ├─ model-pi-ai/
│  │  ├─ session-jsonl/
│  │  ├─ tools-core/
│  │  ├─ context/
│  │  ├─ skills/
│  │  ├─ compaction/
│  │  ├─ approval/
│  │  └─ telemetry/
│  └─ coding-agent/               # Pi 产品层逐步迁移
└─ examples/
   ├─ minimal-headless/
   └─ custom-plugin/
```

注意：逻辑插件不等于 npm 包。只有需要独立发布、独立运行或已经形成稳定依赖边界时才拆包，避免复制 DeepSeek Harness 的包数量。

## 6. 插件内核设计

### 6.1 对外契约

```ts
interface PluginManifest {
  id: string
  version: string
  provides?: ServiceToken<unknown>[]
  requires?: ServiceToken<unknown>[]
  optional?: ServiceToken<unknown>[]
}

interface HarnessPlugin<TConfig = unknown> {
  manifest: PluginManifest
  activate(ctx: PluginContext, config: TConfig): void | Disposable | Promise<void | Disposable>
}

interface PluginContext {
  signal: AbortSignal
  provide<T>(token: ServiceToken<T>, value: T): Disposable
  require<T>(token: ServiceToken<T>): T
  get<T>(token: ServiceToken<T>): T | undefined
  on(...args: unknown[]): Disposable
  effect(setup: () => Disposable | Promise<Disposable>): Disposable
}
```

`provides/requires/optional` 必须在执行 `activate()` 前可读，使宿主能够先构建完整依赖图。动态子插件不能通过 Context 绕过这一步；MVP 中的嵌套组合必须先进入 Profile/Bundle 的 resolved manifest，再由 PluginHost 统一挂载。

### 6.2 生命周期

```text
discover
→ resolve dependency graph
→ validate composition
→ activate
→ ready
→ stop accepting work
→ abort/drain owned tasks
→ reverse-order dispose
```

必须满足：

- Activate 中途失败时，已登记 Effect 立即逆序回滚。
- Disposer 幂等，并绑定具体 registration id，旧 disposer 不能删除新的同名注册。
- 卸载 Provider 前先停止依赖它的 Consumer。
- 同一 Scope 的单值 Service 重复提供默认报错。
- 首版依赖缺失直接失败，不做无限 Pending。
- 依赖解析只读取静态 PluginManifest；`activate()` 不能临时声明影响 DAG 的新 Service。
- Scope 首版只实现 global → agent；Turn/Step 可通过临时子作用域或 Snapshot 实现。
- Scope 是可见性与生命周期机制，不是安全沙箱。

### 6.3 Cordis 采用策略

推荐设置一个短期技术决策门：

1. 项目公开 API 始终是自有的 `PluginContext`、`ServiceToken` 和 `PluginHost`。
2. 用一个 Spike 验证是否在 `cordis-adapter` 内复用 Cordis Core 的 Context、Fiber、Service、Effect 与事件实现。
3. 不允许 Cordis 类型泄露到 `plugin-sdk`、Pi Core 或第三方插件。
4. 不引入 Loader、Include、HMR 等完整 Cordis 组合，除非后续阶段有真实需求。
5. 如果 Cordis Core 无法满足体积、启动性能、错误语义或隔离测试，则保持相同公开 API，切换为小型自研 PluginHost。

这样既能利用 DeepSeek Harness 的成熟生命周期语义，也不会让项目被 Cordis 实现锁死。

## 7. Service Seam

只为真正需要替换的能力建立 Service：

| Service | Definition | 首批 Provider | Consumer |
|---|---|---|---|
| Models | Pi Model/Models 接口 | pi-ai | AgentDriver |
| SessionStorage | Pi SessionStorage | memory、JSONL；SQLite 后续可选 | Harness Runtime |
| FileSystem | 通用文件接口 | local | read/write/edit tools |
| ProcessRunner | 命令执行接口 | local | bash tool |
| Approval | ask/allow/deny | headless policy、CLI UI | Tool Pipeline |
| AgentDriver | Turn/Step 驱动接口 | Pi Agent Loop | Agent Registry |

规则：

- Definition 只声明 DTO、错误和生命周期，不含具体实现或模型 Prompt。
- Provider 拥有默认值与资源。
- Consumer 只依赖 Definition。
- 默认值在 Provider 边界通过 `resolve(request) → resolved spec → run(spec)` 统一解析。
- 只有出现两个实现或一个真实外部 Consumer 时才新增 seam，避免为插件化而插件化。

## 8. 三类事件域

不能把所有事件塞进一个万能 EventBus。

### 8.1 Durable Facts

用于恢复、回放和投影。首版包括：

- Session/operation start、finish。
- Turn/Step start、end。
- User message。
- Assistant final message。
- Tool call、tool result。
- Model、thinking level、active tools 变化。
- Compaction replacement。
- Request snapshot 或等价配置锚点。
- 中断、失败和修复事实。

优先扩展 Pi 当前 Entry/LaneRecord，不创建另一套同义 Event 类型。

### 8.2 Live Agent Events

只服务于正在运行的 Agent：

- Agent created/disposed/status。
- Assistant delta。
- Tool progress。
- Steer/follow-up 入队和领取。
- Approval request/answer。
- Request error、turn stopping。

默认不持久化高频 token delta；最终 Assistant Message 必须持久化。若以后需要逐 token 回放，可增加独立可选日志层。

### 8.3 Capability Middleware

首版只需要三种派发语义：

- `emit`：观察通知，监听失败隔离。
- `waterfall/around`：串行转换、包装或短路。
- `parallel barrier`：在 flush、shutdown、审计等检查点等待全部完成。

安全 Deny 不走普通 waterfall，而走 monotonic guards。

## 9. Canonical Session 与恢复

直接利用 Pi 当前设计：

- Entry：模型可见或业务持久事实。
- LaneRecord：运行控制、尝试、队列、工具开始、abort 等操作记录。
- 全局递增 `seq`。
- `parentId` 形成分支树。
- Lane 指针代表当前路径。
- Reducer 从有限日志切片恢复运行状态。

新增或强化的约束：

1. Append 前做 lossless JSON 检查和 detached snapshot。
2. Append 成功后冻结对象，再发布给 Observer。
3. Projection 必须是纯函数；Replay 绝不能执行外部副作用。
4. `replay: never` 的工具在恢复时不得重新执行。
5. Compaction 通过追加 replacement 事实遮蔽旧历史，不删除原记录。
6. Prompt Hook 的临时改写默认不入日志。
7. Session 状态、UI 和查询索引都由同一日志投影。
8. 每个 Session 必须且只能选择一个 canonical SessionStorage：Memory 用于临时会话，JSONL 或 SQLite 可作为持久后端；禁止 JSONL 与 SQLite 同时成为可写事实源。若另建 SQLite 查询索引，它只能由 canonical log 重建。
9. 下一次模型请求和 Shutdown 前必须提供明确的 `flush()` barrier。
10. 未闭合 Operation 必须被识别为 suspended、interrupted 或 corruption，不能静默继续。

首版建议保留 Pi 的 Entry/LaneRecord envelope，不强行改造成 DSH 的全部 SessionEvent。需要记录模型请求配置时，可增加 versioned request snapshot Entry/Record。

## 10. Agent Runtime 收敛路线

项目现在存在三块相关能力：

1. Pi 已工作的低层 `Agent` / `agentLoop`。
2. Pi 尚未完成的 `AgentHarness v2`。
3. Pi Coding Agent 中功能丰富但产品耦合较强的 Extension Runtime。

目标不是新增第四套系统，而是收敛：

- `Agent/agentLoop` 保持低层、易嵌入的执行原语。
- `pi-agent-driver` 把低层循环注册成默认 AgentDriver 插件。
- `AgentHarness v2` 成为 durable Runtime 的调用面，逐步完成其真实实现。
- `harness-runtime` 负责 Session、Plugin Scope、Driver 与投影的组合。
- 旧 Pi Extension API 作为兼容 facade，底层注册全部转入 Plugin Scope。
- Coding Agent 最终只依赖 Harness Runtime，不自己拥有第二份 Session 真相。

首批不直接修改 `agent-loop.ts`。Provider、工具、上下文、Turn Hook 与生命周期观察优先通过现有接口或适配器完成。

## 11. 工具执行流水线

固定顺序：

```text
1. validate + freeze args
2. append durable tool/call
3. pre-execute: allow / deny / ask
4. monotonic guards
5. around-execute: timeout / metrics / policy-controlled retry
6. tool body
7. post-execute: normalize / replace result / add context
8. freeze structured result
9. tools/result read-only notification
10. append durable tool/result
11. batch 完成后按序追加 additional context
```

并发规则：

- MVP 可以先保持 Pi 现有并发契约，增加显式 `parallel` / `exclusive` 分类。
- Exclusive Tool 形成 barrier。
- 只有明确声明并发安全的 Tool 才进入有界并行池。
- Tool 完成事件可按真实完成顺序发送。
- Durable ToolResult 和返回模型的结果必须按原始 Tool Call 顺序提交。
- Cancel 后不得启动新的副作用；已启动工具必须进入可解释的终态。
- 默认采用 at-most-once：Tool Body 一旦开始，非幂等工具不得自动重试。
- 只有显式声明幂等、携带稳定 idempotency key，并通过 Provider 能力检查的工具才可执行自动重试。
- 若外部副作用已发生、但 ToolResult 尚未持久化就崩溃，恢复状态必须标记为 `outcome_unknown`，通过人工确认或 Provider reconciliation 处理，不能盲目重放。

首版保留 Pi 当前 ToolResult 形状，不强制所有工具实现 DSH 的完整 presentation/output codec。

## 12. Profile、Bundle 与 Patch

首版只做 startup-only 的纯组合器：

```ts
interface PluginSpec {
  id: string
  plugin: string
  config?: unknown
  enabled?: boolean
  scope?: "global" | "agent"
}

interface Bundle {
  id: string
  plugins: PluginSpec[]
}

interface Profile {
  id: string
  bundles: string[]
  patches?: Patch[]
}
```

规则：

- 每个 PluginSpec 有稳定 id。
- `compose(profile, overlays)` 是无副作用纯函数。
- 输出 resolved manifest，可通过 CLI/SDK 查看。
- Patch 操作显式区分 `insert`、`disable`、`mergeConfig`、`replaceConfig`。
- 不支持任意 JavaScript 表达式配置。
- Session 创建时记录 resolved Profile manifest，但不把全部运行参数永久冻结。
- 每次 Operation/Step 在安全边界冻结实际 Request Snapshot，包括模型路由、Prompt、Tool schema 和相关配置。
- 运行中配置变化必须先成为 Durable Fact，只影响下一个安全边界，不允许改写已经开始的请求。

首批 Profile：

- `minimal`：Pi Models + Pi AgentDriver + Memory Session + 基础工具。
- `coding`：在 minimal 上增加 JSONL、文件、Shell、Skills、Compaction、Approval 和 Telemetry。

## 13. 源码整合策略

1. 在目标目录以当前 Pi commit 建立新仓库基线，并保留 Pi Git 历史。
2. 记录 `upstream-pi` remote、基线 commit、Node/TypeScript 版本和原始测试结果。
3. 初期保留 Pi 原包名，避免“功能迁移 + 全仓改名”同时发生。
4. 新增代码使用内部 `@pi-ds/*` 命名；正式发布前再统一包名和 CLI 名。
5. DeepSeek Harness 不做 Git 历史合并；采用 source-port ledger 记录参考来源、目标文件、改写理由和锁定测试。
6. 每次只移植一个架构能力，并先写 Contract/Conformance Test。
7. 设置 Pi 核心补丁预算；能用适配器完成的改动不得修改 Pi Core。
8. 定期拉取 Pi 上游，用 golden trace 和 API compatibility tests 判断回归。

建议内部技术名：

- 仓库 slug：`pi-ds-harness-agent`
- npm scope：`@pi-ds/*`
- CLI：迁移期沿用 `pi`，正式发布名另立 ADR 决定

## 14. 分阶段执行计划

以下工期仅用于单名熟悉 TypeScript/Agent Runtime 的开发者做量级规划，不是承诺。

### M0：冻结基线与建立护栏（2–3 天）

任务：

- 将指定 Pi commit 建立为新项目初始基线。
- 跑通原始 build、check 和测试。
- 固化普通回复、工具调用、并行工具、abort、steer/follow-up 的事件 golden trace。
- 记录公开 API、启动耗时、内存和包依赖基线。
- 建立首批 ADR、依赖方向测试与 source-port ledger。

退出条件：

- Pi 原测试全绿。
- 未启用新功能时行为与 Pi 基线一致。
- 明确可修改区、适配区和禁止侵入区。

### M1：插件契约、Conformance 与 Cordis 决策门（4–6 天）

任务：

- 定义 ServiceToken、PluginManifest、PluginHost、PluginScope、Effect 和事件接口。
- 先编写依赖排序、冲突、失败回滚、反向 dispose 与事件模式的 Conformance。
- 分别制作最小 Cordis Core Adapter Spike 与最小自研 Host Spike，不扩展为两套正式实现。
- 按体积、启动、错误语义、类型泄露和 Conformance 结果选择唯一实现，并形成 ADR。
- 只完成支撑第一条纵向链路所需的最小功能。

退出条件：

- 两个 Runtime 同进程运行且服务互不污染。
- 插件卸载后 Listener、Timer、Service 和后台任务归零。
- 坏插件启动失败不会留下半初始化状态。
- Cordis 是否采用有可测量、可逆的结论，未选方案被删除而非继续并行维护。

### M2：Pi AgentDriver 与最小纵向闭环（6–9 天）

任务：

- 将 Pi Agent Loop 包装为默认 AgentDriver。
- 先使用 Memory Session，实现 Harness 的 `prompt`、`waitForIdle` 和 `abort`。
- 建立 Agent 创建事务、发布与销毁顺序。
- 实现 Fake Model、一个只读 Tool、最小 PluginHost 和 Headless SDK 示例。
- 打通 minimal Profile，但暂不追求完整恢复和全部 Projection。

退出条件：

- 不修改 Pi Agent Loop 即可替换 Model、Tool 或 AgentDriver。
- 一个 Prompt 能完整经历 Session → Agent → LLM → Tool → Session → Result。
- 每个 Turn 恰好一个终态。
- 销毁 Runtime 后所有作用域资源归零。

### M3：Canonical Session、事件投影与恢复（8–12 天）

当前进度（2026-09-03）：

- 已允许 Minimal Runtime 注入预打开的 canonical Session，因此 Node 侧可直接接入 Pi `JsonlSessionRepo`，核心包不引入 Node 文件系统依赖。
- 已识别 main lane 的未闭合 `run` Operation，并实现 `operation_start`、message tail、assistant terminal、abort 和 error 边界的基础 `resume`。
- 已在 Tool Body 前写入并 flush `tool_started`，为 ToolResult 预留稳定 Entry ID；无 ToolStart 可首次执行、`replay: safe` 可重放、`replay: never` 按 `outcome_unknown` 阻断。
- 已增加真实 JSONL 重开和崩溃边界测试。
- 已增加 `schemaVersion: 1` 请求配置锚点；恢复时会校验系统提示词、模型和工具集合，配置漂移按 `configuration_mismatch` fail-closed。
- Session、Memory、JSONL 和 SQLite 已提供统一 `flush()` barrier；Driver 在模型请求、消息发布和 Operation 终态边界显式等待。
- 已复用 Pi Reducer 建立 messages、turn-state、tool-state Projection；同一 Memory Session 的实时快照、重开 replay 和重复 replay 深度相等。
- M3 的 Minimal Runtime / main-lane `run` 验收范围已经完成。compaction、navigation、非 main lane 与通用 `initialMessages` 恢复随完整 AgentHarness 迁移进入 M6。

任务：

- 复用 Pi Entry/LaneRecord、Storage 和 Reducer。
- 增加必要的请求配置锚点和 schemaVersion。
- 建立 messages、turn-state、tool-state 三个 Projection。
- 落地 JSONL Storage、write-before-publish 和 flush barrier。
- 实现 Harness 的基础 `resume` 与恢复错误分类。
- 建立 Storage conformance kit 和崩溃边界测试。

退出条件：

- 实时状态与完整 Replay 深度相等。
- 从同一日志重建两次得到相同快照。
- 在 Operation、Assistant、ToolStart、ToolResult 边界模拟崩溃均有确定结果。
- Replay 不重新执行外部副作用，未知副作用结果不会被盲目重试。

### M4：正式 Tool/Prompt/LLM 流水线（7–10 天）

当前进度（2026-09-03）：M4 的 Headless Runtime 范围已完成。包括 Tool `pre/guard/approval/around/body/post/result`、scoped Tool Catalog、Prompt Contributor、Pi Models Provider、并发结果顺序、版本化恢复配置、queue/usage 事实与重启恢复，以及非幂等工具 Provider reconciliation。交互式审批前端随 Coding Profile 在 M6 接入。

任务：

- 实现工具 pre/guard/around/body/post/result。
- 接入 Approval seam 和 Headless fail-closed 策略。
- 建立 scoped Tool Catalog 与 Prompt Contributor。
- 完成 Pi Models Provider 插件。
- 固定并发与结果提交顺序。
- 将影响模型的配置和上下文纳入可恢复快照。

退出条件：

- Denied Tool 永远不执行。
- 工具异常全部转成结构化结果。
- 并发工具结果仍按模型调用顺序回填。
- 临时 Prompt View 不污染 Durable Log。
- 非幂等工具不会被自动重试；未知副作用结果进入核对流程。
- Cancel 后不再启动新的副作用，并只产生一个可恢复终态。

### M5：统一插件 API 与组合配置（5–8 天）

当前进度（2026-09-03）：M5 已完成。仓库现在只有一个 public plugin SDK 入口，并提供框架无关的 Plugin conformance test kit；resolved manifest 命令同时校验 minimal/coding Profile 的结构、Service 冲突、缺失依赖和有限 JSON 配置。Profile Patch 支持显式原子 `replace`，Coding Profile 用它将 memory Session 唯一替换为 JSONL Session。Pi 旧 Extension 由 Coding Agent 包内的适配器纳入 Plugin Scope，Scope 释放时统一失效旧 Runtime 并清理事件订阅。Coding Profile 此阶段是已校验的组合契约，CLI/TUI 的实际接线属于 M6。

任务：

- 实现静态 Bundle/Profile/Patch 组合器。
- 提供 resolved manifest 检查命令。
- 将 Pi 旧 Extension API 适配到 Plugin Scope。
- 实现 Plugin conformance test kit。
- 落地 minimal 与 coding Profile。

退出条件：

- 不出现两套资源所有权。
- 同一 Profile 每次解析结果一致。
- 同名 Service 默认冲突，只有显式 replace 才能替换。
- 第三方示例插件只导入 public plugin-sdk。

### M6：Coding Agent 产品迁移（7–12 天）

当前进度（2026-09-14）：Coding Runtime 已通过同一个 `PiAgentDriver` 组合真实 JSONL Session、Pi Coding Tools、Skills、模型调用、Compaction、Approval、Telemetry 与旧 Extension 集合。`--harness-runtime` 已接入基础 TUI、有限 print/JSON 和严格 JSONL RPC，支持 canonical session id/路径/continue/fork、图片初始消息、显式 Extension 工厂以及 TUI 或 RPC 工具审批。单一 `CodingRuntimeController` 统一 prompt/queue/abort/resume/compaction、Extension 命令、动态 Tool/Model/thinking 配置以及树查询/导航；所有消费端读取同一 durable Projection。TUI transcript 只从 Projection 重建，不保存第二份权威 Agent 状态；已接入跨项目/显式路径 Session、canonical 树与带摘要导航恢复、临时流式覆盖层、当前分支 Fork/切换、new/reload，以及 model、thinking、active tools selector。Extension 生命周期、输入/消息/工具变换和恢复仍遵守 write-before-publish；Extension Context 的 new/switch/fork/reload 已委托给 Runtime Host，`withSession` 在原子替换后绑定新 Session。旧 CLI/RPC/TUI 兼容矩阵已建立；RPC 已补 new/clone Session、模型/思考目录与循环、摘要导航、跨项目参数、Entry cursor、Session stats、Fork 消息、最后 Assistant 文本、durable `clear_queue` 与 canonical HTML export，并完成 burst/shutdown 与 Host replacement 并发测试。TUI `/export` 复用同一导出入口。Prompt template 已在 Controller 输入边界展开，展开结果进入 canonical run intent，并在 Host replacement 时按 trust 重新加载。Scoped-model patterns 已统一限制 TUI/RPC 模型目录，并保留显式模型和 per-model thinking 行为。RPC Extension UI 已支持 fail-closed dialog 与单向事件；TUI Extension UI 已接入 select/confirm/input/editor、通知、状态、标题、terminal input 和 editor text，并在 stop/Host replacement 时取消未决交互。剩余 custom component、widget/header/footer、editor provider 与旧 Pi 交互细节仍待迁移。

任务：

- 复用 Pi 文件、搜索、编辑和 Shell 工具。
- CLI/TUI 改为消费 Harness Runtime 与 Projection。
- 接入 JSONL、Skills、Compaction、Approval 和 Telemetry 插件。
- 保留旧 Pi CLI 行为兼容测试。
- 完成 Coding Profile 的端到端测试。

退出条件：

- CLI 与 Headless SDK 对同一 Session Log 得到一致结果。
- UI 不保存第二份权威 Agent 状态。
- Resume、Compaction、Abort 和工具审批可用。
- 常见 Pi 工作流达到基线功能等价。

### M7：可靠性、发布与高级能力（按需求排期）

候选能力：

- SQLite 查询投影与缓存。
- Lane、Fork、Subagent。
- 有界工具池与资源锁。
- Sandbox/远程执行。
- MCP、LSP、长期记忆、浏览器。
- 动态插件发现、安装和 HMR。
- SDK/RPC/ACP。

准入条件：M0–M6 的事件协议、生命周期和唯一事实源已经稳定。

## 15. 第一批开发任务

建议按以下顺序建立 Issue：

1. `BOOT-001`：复制 Pi 基线、记录 commit 与测试结果。
2. `ARCH-001`：定义不可插件化微内核与依赖规则。
3. `KERNEL-001`：ServiceToken 与单值服务冲突。
4. `KERNEL-002`：PluginScope、AbortSignal、LIFO Effect。
5. `KERNEL-003`：依赖 DAG、循环检测、事务式 Activate。
6. `EVENT-001`：三事件域与派发语义。
7. `SESSION-001`：Pi Entry/LaneRecord 复用决策与版本策略。
8. `SESSION-002`：write-before-publish 与 Projection Registry。
9. `DRIVER-001`：Pi AgentDriver Adapter。
10. `VERTICAL-001`：Fake Model + read-only Tool + Memory Session。
11. `TOOLS-001`：固定 Tool Pipeline 与 monotonic guards。
12. `PROFILE-001`：minimal Profile 与 resolved manifest。

第一轮演示目标：

> 使用 Headless SDK 启动 minimal Profile，加载一个自定义 Prompt 插件和一个只读工具，完成一次 Tool Call；销毁并重建 Runtime 后，从同一日志恢复出完全相同的模型历史。

## 16. 测试与质量门槛

### 16.1 单元测试

- Service 注册、冲突、替换和 Scope 查找。
- 插件依赖排序、缺失依赖和循环。
- Effect 反向释放、幂等和失败回滚。
- Event 派发顺序、next 仅调用一次、Observer 错误隔离。
- Reducer 与 Projection 纯函数。
- Tool Guard 单调性。

### 16.2 Conformance

- Memory、JSONL、SQLite SessionStorage 使用同一套测试。
- 每个 AgentDriver 使用同一套 lifecycle 测试。
- 每个 Tool Provider 使用同一套 abort/error/result 测试。
- 第三方插件只通过 Plugin SDK 测试。

### 16.3 集成测试

- Fake LLM 普通响应。
- 单工具、多工具、并发工具和失败工具。
- Steer、follow-up、abort 和 retry。
- Prompt/Tool/Model 插件组合。
- 插件启动失败和运行中 Handler 抛错。
- Session 重启恢复与未闭合 Operation。

### 16.4 故障注入

- Append 失败。
- Flush 失败。
- Assistant 完成前崩溃。
- Tool 已开始但结果未写入时崩溃。
- Plugin activate/dispose 抛错。
- Approval 无 UI、取消或超时。

### 16.5 架构守卫

- Agent Core 不得依赖 CLI、TUI、SQLite 或具体 Coding Tool。
- Pi Provider 实现不得依赖 Plugin Runtime。
- Projection 不得调用网络、文件写入或 Tool。
- UI 不得写 canonical Session。
- 只有 Harness Runtime 可以提交 Turn terminal fact。

### 16.6 性能预算

- 记录 Pi 基线后再冻结绝对指标。
- 暂定 minimal Profile 冷启动相对 Pi 回退不超过 20%。
- Harness 固定框架开销暂定不超过 5%，排除模型和工具耗时。
- 插件数量增长时启动时间应近似线性。
- Projection 可通过增量折叠工作，不能每个 token 重放全日志。

## 17. 主要风险与控制

| 风险 | 等级 | 控制措施 |
|---|---:|---|
| Pi Session 与新 EventLog 形成双事实源 | P0 | 复用 Entry/LaneRecord；只允许一个 durable writer |
| 新增第三套 Agent Loop | P0 | Pi AgentDriver；一个 Agent 只能选择一个 Driver |
| 为插件化大改 Pi Agent Core | P0 | 适配优先；核心补丁预算；上游差异清单 |
| Pi Extension 与新 Plugin 各自拥有资源 | P0 | 旧 API 只做 facade；所有资源归 PluginScope |
| Replay 重新执行副作用 | P0 | Facts/Commands 分离；Projection 纯函数；replay policy |
| 插件取消后仍有 Timer/进程运行 | P0 | Scope AbortSignal、托管任务、反向 dispose 测试 |
| 工具并发破坏因果顺序 | P0 | 显式并发安全；exclusive barrier；按源顺序提交 |
| 运行中 Prompt/Tool 集漂移 | P1 | 记录 Profile manifest；每 Operation/Step 冻结 snapshot；变化只在安全边界生效 |
| Waterfall 顺序不确定 | P1 | 固定阶段、显式 priority、注册序、next-once |
| Cordis 类型污染公共 API | P1 | 自有 facade；只有 cordis-adapter 可导入 Cordis |
| 包数量快速膨胀 | P1 | 逻辑模块先同包；发布边界稳定后再拆 |
| 过早追求 Oh My Pi 功能规模 | P1 | 每项能力通过使用场景与 seam 准入评审 |
| 文件夹名含空格和加号 | P2 | 顶层保持原名；脚本始终加引号；内部统一 slug |

## 18. 从其他 Agent 借鉴的设计

### Amadeus

- Runtime 是唯一状态所有者。
- Thread、Session、Turn、Step 身份清晰。
- JSONL 是事实，SQLite 是可重建索引。
- UI 只做 Event Projection。
- 用自动化依赖守卫锁定架构边界。

### Oh My Pi

- 插件注册期与运行期分离。
- Timer、后台 Promise 和资源由宿主管理。
- 无 UI 环境必须有明确降级。
- 对取消、恢复、事件顺序和并发竞态做回归测试。
- 高级能力应作为 Provider/Plugin，不应塞入内核。

### my-pi-agent

- Fake LLM、离线工具和故障注入优先。
- 保持 Agent Loop 可读。
- 工具错误在边界转成结构化结果。
- 每项功能先完成小型纵向闭环。

### pi_agent_rust

- 借鉴显式取消、进程树清理、原子 Session 写入和恢复不变量。
- 不借鉴其大型单文件、过度兼容和范围持续扩张的结构。

## 19. 首批 ADR

1. Pi 基线版本与上游同步策略。
2. Cordis Core 私有适配还是自研 PluginHost。
3. 不可插件化微内核的范围。
4. Durable、Live、Capability 三事件域边界。
5. 唯一事实源与 write-before-publish。
6. Thread/Session/Turn/Step/ToolCall 身份。
7. Plugin Scope 与销毁顺序。
8. Service 冲突、优先级与显式替换。
9. Waterfall、Observer 与 Guard 失败语义。
10. Tool 并发和资源锁。
11. 临时 Prompt View 与 Durable History 的边界。
12. Event schema 版本与迁移策略。
13. Pi 旧 Extension API 的兼容期限。
14. 产品能力与通用核心的包边界。

每份 ADR 必须包含：背景、决定、备选方案、后果、可逆条件、不变量和锁定该决定的测试。

## 20. MVP Definition of Done

- Pi 基线测试保持全绿。
- Core 不依赖 CLI、TUI、具体存储和 Node 原生模块。
- 同进程可创建两个互不污染的 Runtime。
- 每个 Turn 恰好一个 terminal fact。
- Durable Fact 先写成功，再被观察。
- 实时 Projection 与完整 Replay 相等。
- JSONL 尾部半写可恢复到最后完整记录。
- 插件加载失败、Handler 抛错和 Dispose 抛错均有确定行为。
- 插件销毁后 Service、Listener、Timer 和任务计数归零。
- 临时 Context Hook 不进入持久日志。
- Denied Tool 不执行。
- 并发 ToolResult 按模型原始顺序回填。
- Cancel 后不启动新的副作用。
- 所有核心测试可以完全离线运行。
- 至少一个第三方示例插件只依赖公开 Plugin SDK。
- Minimal Profile 的启动和嵌入体验仍保持 Pi 的轻量特征。

## 21. 建议的下一步

批准本报告后，先执行 M0，不立即开发高级插件：

1. 将 Pi 指定 commit 复制/克隆到目标目录并保留历史。
2. 建立 `UPSTREAM_BASELINE.md`、ADR 目录和 source-port ledger。
3. 跑全量基线测试，保存结果。
4. 建立 Plugin Runtime 的最小接口与 Cordis Core Spike。
5. 用 Fake LLM + Memory Session + 单只读工具完成第一条纵向链路。

只有第一条纵向链路同时通过运行、持久化、恢复、销毁和离线测试后，才进入 Coding Bundle 和更多工具迁移。

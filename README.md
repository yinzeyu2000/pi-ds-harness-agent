# pi+ds harness agent

[English](README.en.md) | **简体中文**

一个以 [Pi](https://github.com/earendil-works/pi) 为执行底座、吸收 DeepSeek Harness 组合思想的 TypeScript Agent Harness。

项目的目标是同时保留两种特性：

- 像 Pi 一样轻量、清晰、容易嵌入；
- 像 DeepSeek Harness 一样可组合、可回放，并具有可逆的插件生命周期。

当前处于早期开发阶段。第一批开发已经完成插件微内核、Pi AgentDriver、Memory Session 纵向闭环和离线契约测试；尚不建议直接用于生产环境。

## 核心原则

- **只有一个 Agent Loop**：默认 Driver 直接包装 Pi Agent，不重复实现执行循环。
- **只有一个事实源**：继续使用 Pi Session 的 Entry/LaneRecord，不建立第二套 Session Log。
- **插件贡献全部可逆**：服务、监听器和后台资源归 Plugin Scope 管理，按相反顺序释放。
- **默认保持轻量**：Minimal Profile 只加载模型、Memory Session、Prompt、工具和 Pi AgentDriver。
- **安全拒绝不可覆盖**：Tool Guard 一旦拒绝，后续处理不能重新允许执行。

## 已实现

- 类型安全的 `ServiceToken` 和隔离的服务作用域；
- 插件静态依赖解析、缺失依赖和循环检测；
- 单值服务冲突检测；
- 事务式插件激活与失败回滚；
- `AbortSignal`、幂等释放和 LIFO Effect；
- Durable Facts、Live Events、Capability Middleware 三类事件语义；
- write-before-publish 和纯函数 Projection Registry；
- 确定性的 Profile / Bundle / Patch 组合器；
- 固定 `pre/guard/approval/around/body/post/result` 顺序的工具流水线、Headless 默认拒绝和结构化阶段异常；
- 可选 `--harness-runtime` print/JSON/RPC CLI、终端或 RPC 逐工具审批与显式 Extension 工厂加载；
- 单一 `CodingRuntimeController` 与 durable Projection，统一驱动 print、JSON 和严格 JSONL RPC 消费端；
- RPC prompt/queue/abort/resume/compaction、Extension 命令、配置切换、树查询/导航和优雅关闭；
- canonical session id/路径/continue、图片初始消息，以及空闲期动态 Tool/Model/thinking level 切换；
- Extension 命令、Agent/Tool 生命周期、pre-commit 消息变换及可恢复初始输入；
- scoped Tool Catalog，以及纳入恢复配置锚点的版本化工具策略；
- scoped Prompt Contributor 和不写入消息日志的临时 Prompt View；
- Pi Models Provider、精确模型选择及恢复时的模型配置校验；
- 并发工具完成顺序与 ToolResult 提交顺序解耦，结果始终按模型调用顺序持久化；
- steer/follow-up queue 事实、Assistant/Tool usage 事实，以及重启后的待处理队列恢复；
- 非幂等工具 Provider reconciliation；默认未知结果仍保持 `outcome_unknown`；
- `PiAgentDriver` 的 prompt、abort、steer、follow-up 控制契约与可恢复的 Minimal Headless Runtime；
- 可注入 JSONL Session、未闭合 Operation 分类、保守 `resume` 和未知工具副作用拦截；
- 版本化请求配置锚点、恢复配置漂移拦截，以及 Memory/JSONL/SQLite 统一 `flush()` barrier；
- 基于 Pi Reducer 的 messages、turn-state、tool-state Projection；
- Tool Body 前的 `tool_started` 事实、稳定 ToolResult ID，以及 `safe`/`never` 恢复策略；
- Fake Model + 只读 Tool + Memory Session 的完整离线演示测试。

## 架构

```text
产品 / SDK / CLI
       │
       ▼
Profile / Bundle / Patch
       │
       ▼
PluginHost ── Service / Scope / Effect / Events
       │
       ▼
PiAgentDriver ── Pi Agent / agentLoop
       │
       ▼
Pi Session Entry + LaneRecord（唯一事实源）
```

新增组合层位于 [`packages/harness-runtime`](packages/harness-runtime)。Pi 原有模型、Agent、TUI、协议和 Coding Agent 包在迁移阶段保持原包名。

## 快速开始

要求：Node.js 22.19 或更高版本、npm。

```bash
git clone https://github.com/yinzeyu2000/pi-ds-harness-agent.git
cd pi-ds-harness-agent
npm install
npm run hydrate:model-data
npm run build:offline
npm test --workspace=@pi-ds/harness-runtime
```

模型目录来自 Pi 的生成流程，因此首次离线构建前需要执行一次 `hydrate:model-data`。

## 验证状态

- 全仓 TypeScript、格式、依赖和浏览器打包检查通过；
- 全仓离线构建通过；
- Harness Runtime：9 个测试文件、51 个测试全部通过，且不依赖网络和 Shell；
- Pi 上游完整测试在当前 Windows 环境中仍存在 Bash 自动发现、符号链接权限、Unix socket 和路径分隔符差异，详情见[基线测试记录](docs/baseline-results.md)。

## 文档

- [执行报告与开发计划](EXECUTION_PLAN.md)
- [上游基线](UPSTREAM_BASELINE.md)
- [架构约束](docs/architecture.md)
- [事件模型](docs/event-model.md)
- [M3 JSONL 恢复开发交接](docs/handoff-m3-jsonl-recovery.md)
- [M4 Tool/Prompt/Models 开发交接](docs/handoff-m4-tool-pipeline.md)
- [M5 插件 SDK 与组合配置开发交接](docs/handoff-m5-plugin-composition.md)
- [M6 第一批 Coding Runtime 开发交接](docs/handoff-m6-coding-runtime.md)
- [Harness RPC 协议](docs/harness-rpc.md)
- [源码参考台账](docs/source-port-ledger.md)
- [ADR：唯一 Session 与 Agent Loop](docs/adr/0001-single-session-and-agent-loop.md)
- [ADR：插件宿主实现](docs/adr/0002-plugin-host-implementation.md)
- [ADR：三事件域](docs/adr/0003-event-domains.md)

## 路线图

接下来的重点是：

1. 让 TUI 消费 Harness Runtime 与 Projection，不保存第二份权威状态；
2. 补全跨文件会话切换、Fork、带摘要的树导航和剩余 Extension 兼容边界；
3. 建立旧 Pi CLI/RPC 行为兼容矩阵并增加协议压力测试；
4. 扩展 Coding Profile 的崩溃注入与真实交互端到端测试。

完整阶段计划见 [`EXECUTION_PLAN.md`](EXECUTION_PLAN.md)。

## 项目来源与许可证

本项目基于锁定的 Pi 源码快照开发；公开仓库使用独立的精简提交历史，不包含 Pi 的完整 Git 历史。新增组合层借鉴了 DeepSeek Harness 的架构思想，但使用项目自有接口和实现；参考关系记录在源码参考台账中。

项目沿用仓库中的 MIT License。进入公开发行或商业部署前，仍应对所有第三方依赖和参考实现进行独立合规审查。

## 贡献

项目处于架构收敛期，欢迎通过 Issue 提交使用场景、错误报告和设计建议。新增功能应遵守“一个 Agent Loop、一个事实源、一套正式插件 API”的约束。

# Harness Runtime 兼容矩阵

日期：2026-09-14

本表比较旧 Pi Coding Agent 消费面与 `--harness-runtime`。状态含义：

- **等价**：主要用户行为已由 canonical Runtime 实现；
- **适配**：能力已实现，但命令名、字段或 durable 语义有意不同；
- **待迁移**：当前拒绝或尚未暴露；
- **不支持**：与唯一 JSONL 事实源冲突，当前不计划按旧语义实现。

## CLI

| 旧 Pi 能力 | Harness Runtime | 状态 | 说明 |
|---|---|---|---|
| interactive / `--print` / `--mode json` / `--mode rpc` | 同名入口 | 等价 | 四种消费端共享 `CodingRuntimeController` 与 durable Projection。 |
| `--provider`、`--model`、`--api-key`、`--thinking` | 同名参数 | 等价 | 选择进入下一次版本化请求配置。 |
| `--system-prompt`、`--append-system-prompt`、`--no-context-files` | 同名参数 | 等价 | 跨项目切换后按目标 cwd 重建上下文。 |
| `--session`、`--session-id`、`--continue`、`--session-dir` | 同名参数 | 等价 | Session id 或 JSONL path 定位 canonical Session。 |
| `--name` | 同名参数 | 等价 | 写入 canonical Session metadata。 |
| `@file` 与图片初始输入 | 同名参数 | 等价 | 最终输入进入同一 run intent 与 JSONL。 |
| `--tools`、`--exclude-tools`、`--no-tools`、`--no-builtin-tools` | 同名参数 | 适配 | 使用 Harness Tool Catalog；副作用工具仍要求 Approval。 |
| `--extension` 与 Extension flags | 同名参数 | 适配 | 显式工厂在 Plugin Scope 内原子激活；尚不执行完整旧资源发现。 |
| `--skill`、`--no-skills` | 同名参数 | 等价 | Skill 通过 Prompt Contributor 进入临时模型视图。 |
| `--resume` | 拒绝；TUI 使用 `/sessions` | 待迁移 | 旧参数打开选择器，不能在 finite 模式无交互复现。 |
| `--fork` | 同名参数；TUI `/fork`、RPC `fork_and_switch` | 等价 | 启动参数复制 source 当前分支到启动 cwd，可用 `--session-id` 指定新 id。 |
| `--models` | 同名参数 | 等价 | pattern 解析为 TUI/RPC 共享候选集，可携带 thinking level；显式切入 scope 外模型后将其纳入当前集合。 |
| `--prompt-template`、`--no-prompt-templates` | 同名参数 | 等价 | 模板在 Driver 之前展开，展开结果进入 canonical run intent；未信任项目的默认模板不加载。 |
| `--theme` | 拒绝；交互式 `--use-theme` 可用 | 待迁移 | 自定义主题资源发现尚未迁移。 |
| `--no-session` | 拒绝 | 不支持 | Harness 的恢复、Approval 与 write-before-publish 依赖 durable Session；如需临时运行应设计明确的 Memory Session Profile。 |

## RPC

Harness RPC 使用严格 LF JSONL。每个输入命令产生一个带原 `id` 的响应，Agent event、Projection 和 Approval 是独立事件。

| 旧 RPC 命令/行为 | Harness RPC | 状态 | 差异 |
|---|---|---|---|
| `prompt`、`steer`、`follow_up`、`abort` | 同名 | 等价 | `prompt` 忙时失败；队列追加必须显式选择 steer/follow-up。 |
| `get_state` | `get_snapshot`、`get_recovery` | 适配 | 返回 canonical durable read model，不复制旧 AgentSession 状态。 |
| `get_messages`、`get_entries`、`get_tree`、`get_commands` | 同名 | 适配 | Entry cursor 与 Tree 均读取 canonical Session；Tree 返回 Entry + Lane，命令列出 Extension 与 prompt template。 |
| `fork`、`switch_session` | `fork_session`、`fork_and_switch`、`switch_session` | 适配 | Hosted RPC 可按 `{cwd, sessionId}` 跨项目原子替换 Runtime。 |
| tree navigation | `navigate` | 适配 | 支持 durable navigation、可选分支摘要及崩溃恢复。 |
| `set_model`、`set_thinking_level` | 同名 | 适配 | `set_model` 同时接受旧 `modelId` 与规范字段 `model`；仅允许空闲期变更。 |
| active tool 变更 | `set_active_tools` | 适配 | 直接选择 Harness Tool Catalog 名称。 |
| `compact` | 同名 | 等价 | 返回 canonical Compaction Entry。 |
| Extension UI 请求 | `extension_ui_request` / `extension_ui_response` | 适配 | RPC 支持 select/confirm/input/editor dialog 与 notify/status/widget/title/editor-text 单向事件；custom component 不跨协议传输。 |
| `new_session` | 同名；增加可选 `sessionId` | 等价 | Hosted RPC 原子替换 Runtime；`parentSession` 支持 id/path。 |
| `clear_queue` | 同名 | 适配 | 与 enqueue 串行化；逐条 flush `queue_cancelled` 后清除进程队列，并分别返回 steering/follow-up 文本。 |
| available model/thinking 查询 | `get_available_models`、`get_available_thinking_levels` | 等价 | 模型目录由产品层注入并遵守 scoped models，thinking 级别按当前模型能力计算。 |
| model/thinking cycle | `cycle_model`、`cycle_thinking_level` | 等价 | 变更同步给后续 Session replacement 的 Runtime factory。 |
| queue mode、auto compaction、auto retry | 无公开命令 | 待迁移 | 需要先定义可恢复配置事实，不能只改进程内开关。 |
| `bash`、`abort_bash` | 无直接等价命令 | 待迁移 | 工具调用目前经 Agent/Tool Pipeline 与 Approval 执行。 |
| stats、fork messages、last assistant text | `get_session_stats`、`get_fork_messages`、`get_last_assistant_text` | 等价 | 历史计数/费用读取全部 JSONL Entry 与 Usage Record；当前上下文和最后回复读取活动 Projection。 |
| `clone` | 同名；增加可选 `sessionId` | 适配 | Hosted RPC 在当前 leaf 按 `position: at` Fork，并原子切换到新 Runtime。 |
| HTML export | `export_html` | 等价 | 直接读取 canonical Entry、main leaf 与 label facts；相对输出路径按活动 Runtime cwd 解析。 |
| graceful close | `shutdown` 或 stdin EOF | 等价 | shutdown 中止在途 run；EOF 等待已受理工作并关闭未决 Approval。 |

## TUI

| 旧 Pi TUI | Harness TUI | 状态 | 说明 |
|---|---|---|---|
| 普通 prompt、流式 Assistant、abort | 同行为 | 等价 | 流式内容是临时覆盖层，最终 transcript 来自 Projection。 |
| tool Approval | editor 内确认 | 等价 | abort/退出默认拒绝。 |
| `/model`、`/thinking` | 同名 selector | 等价 | 通过 Controller 更新 Runtime。 |
| active tools | `/tools` | 适配 | 使用 Harness Tool Catalog。 |
| `/tree` | `/tree [summarize [instructions]]` | 适配 | 使用 canonical Entry/Lane 与可恢复 navigation Operation。 |
| `/fork` | `/fork [id]` | 等价 | Fork 后立即原子切换 Host。 |
| `/resume` Session selector | `/sessions [current\|all]`、`/session <id\|path>` | 适配 | Harness `/resume` 专指恢复未闭合 Operation。 |
| `/compact`、`/name`、Extension commands | 同名 | 等价 | Extension 命令结束前 flush durable 动作。 |
| `/new`、`/reload` | `/new [id]`、`/reload` | 等价 | 通过 Host 原子替换 Runtime；reload 重建 Extension Scope。 |
| `/settings`、`/scoped-models` | 无内建命令 | 待迁移 | 启动配置与模型目录已有底层服务。 |
| `/export`、`/share`、`/copy` | `/export [path]`；share/copy 待迁移 | 部分 | HTML 是 Session 的外部派生视图，不写入事实；share/copy 仍需产品适配。 |
| `/login`、`/logout` | 无内建命令 | 待迁移 | Model Runtime 已有凭据能力，TUI 流程尚未接入。 |
| `/changelog`、`/hotkeys`、`/debug` | 无内建命令 | 待迁移 | 非核心功能。 |
| 自定义 Extension TUI widgets/dialogs | no-op UI Context | 待迁移 | 需要在不引入第二份状态的前提下绑定 Harness TUI 焦点层。 |

## Extension Context

| API | 状态 | 边界 |
|---|---|---|
| `newSession`、`fork`、`switchSession`、`reload` | 等价 | 由 Runtime Host 替换；`withSession` 绑定新 Session。 |
| `navigateTree` | 适配 | canonical navigation 可用；`replaceInstructions` 显式拒绝。 |
| `sendMessage`、`sendUserMessage`、`appendEntry`、name、label | 等价 | 全部写入当前 canonical Session。 |
| model、thinking、tools、commands、flags、events | 等价或适配 | 经 Extension Runtime 与 Controller 接入。 |
| `newSession.setup(SessionManager)` | 不支持 | 会创建第二套可写 Session 权威状态，因此显式报错。 |
| 旧同步 `sessionManager` 树读取 | 待迁移 | canonical Session API 为异步；当前只提供 cwd/id/path/name。 |
| 通用 Extension UI | 部分 | RPC 已有 fail-closed dialog bridge；TUI 已接入 dialog、custom/overlay、widget/header/footer、通知、状态、标题、terminal input、editor provider/text 与 theme，autocomplete/working indicator/hidden thinking/tool expansion 待迁移。 |

## 后续优先级

1. 补齐 TUI Extension autocomplete、working indicator、hidden thinking 与 tool expansion。
2. 扩大 JSONL 崩溃注入与 Runtime replacement 并发测试。
3. 补齐 share/copy 等剩余产品输出适配。

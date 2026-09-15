# Harness RPC 协议

`pi --harness-runtime --mode rpc` 在 stdin/stdout 上使用严格 LF 分隔的 JSONL。每行是一条完整 JSON；字符串内部的 Unicode 行分隔符不会被当作记录边界。

客户端命令可以带字符串 `id`。服务端对每条有效或无效命令返回：

```json
{"id":"1","type":"response","command":"get_snapshot","success":true,"data":{}}
```

运行期间还会主动输出三类事件：

- `runtime_snapshot`：从 canonical Session 重建的完整 durable read model；
- `agent_event`：当前 Agent 的流式生命周期事件；
- `approval_request`：等待客户端决定的工具副作用请求。
- `extension_ui_request`：Extension 的 dialog 或单向产品 UI 请求。

## 命令

| 命令 | 关键字段 | 行为 |
|---|---|---|
| `prompt` | `message` | 空闲时启动新 run，立即确认受理 |
| `steer` | `message` | 向当前 run 的 steer 队列写入消息 |
| `follow_up` | `message` | 向当前 run 的 follow-up 队列写入消息 |
| `abort` |  | 中止当前 run |
| `clear_queue` |  | 持久化取消当前 run 尚未消费的 steer/follow-up 消息，并返回两类已清理文本 |
| `export_html` | `outputPath?` | 从 canonical Session 生成自包含 HTML；相对输出路径按当前 Runtime cwd 解析 |
| `resume` |  | 恢复 canonical Session 中可恢复的未闭合 run |
| `compact` | `customInstructions?` | 执行 durable compaction |
| `get_snapshot` |  | 返回 Runtime 与 Session 投影 |
| `get_messages` |  | 返回当前分支的模型消息 |
| `get_session_stats` |  | 返回全 Session 历史计数、Usage Record 汇总和当前上下文占用 |
| `get_last_assistant_text` |  | 返回当前 Projection 最后一条已提交 Assistant 文本 |
| `get_entries` | `since?` | 返回所有 canonical Entry 与 main leaf；`since` 是严格排他的 durable cursor |
| `get_fork_messages` |  | 返回所有可作为 Fork 起点的用户消息 Entry |
| `get_recovery` |  | 返回恢复分类 |
| `get_tree` |  | 返回所有 Entry 与 lane pointer |
| `navigate` | `entryId`, `summarize?`, `customInstructions?`, `label?` | 原子移动 main lane；可选生成可恢复的废弃分支摘要 |
| `fork_session` | `sessionId?`, `entryId?`, `position?` | 从当前分支原子创建新的 JSONL Session 文件 |
| `switch_session` | `sessionId`, `cwd?` | 事务式创建替代 Runtime、释放旧 Scope 并切换 Session；`cwd` 可定位跨项目 Session |
| `fork_and_switch` | `sessionId?`, `entryId?`, `position?` | Fork 后立即通过 Runtime Host 切换 |
| `clone` | `sessionId?` | 在当前 main leaf 克隆分支并通过 Runtime Host 切换 |
| `get_commands` |  | 列出 Extension 与 prompt template 命令及其来源 |
| `new_session` | `sessionId?`, `parentSession?` | 新建并切换 canonical Session；父 Session 可按 id 或 JSONL path 定位 |
| `get_available_models` |  | 返回产品层提供的已认证模型目录 |
| `get_available_thinking_levels` |  | 返回当前模型支持的 thinking level |
| `cycle_model` |  | 按模型目录循环切换并返回新模型 |
| `cycle_thinking_level` |  | 按当前模型能力循环切换 thinking level |
| `invoke_command` | `name`, `args?` | 执行 Extension 命令并 flush 其 durable 动作 |
| `set_session_name` | `name` | 设置 canonical Session 名称 |
| `set_active_tools` | `names` | 空闲期切换下一次请求使用的工具 |
| `set_model` | `provider`, `model` | 空闲期切换模型 |
| `set_thinking_level` | `level` | 空闲期切换 thinking level |
| `approval_response` | `requestId`, `decision`, `reason?` | 回答工具审批；decision 为 `allow` 或 `deny` |
| `extension_ui_response` | `id`, `value` / `confirmed` / `cancelled` | 回答同 id 的 Extension UI dialog |
| `shutdown` |  | 中止在途工作、排空持久化并结束 RPC |

## 审批往返

副作用工具在执行前产生：

```json
{"type":"approval_request","request":{"id":"call-1","name":"write","args":{"path":"result.txt"}}}
```

客户端必须使用同一个请求 id 回答：

```json
{"id":"approval-1","type":"approval_response","requestId":"call-1","decision":"allow"}
```

若 stdin 在回答前关闭，所有悬挂审批都会 fail-closed，工具不会执行。正常 EOF 会等待已受理命令和 Agent run 完成；需要主动退出时使用 `shutdown`，无需先关闭 stdin。

## 顺序与状态

- 输入命令严格按行串行分发；Agent 事件和响应按实际发生顺序写入同一输出流。
- `prompt` 在 run 进行中会失败；运行中追加输入应使用 `steer` 或 `follow_up`。
- `clear_queue` 与并发 enqueue 串行化；每条 `queue_cancelled` 必须 flush 后才从 Agent 队列移除，重启恢复不会重新注入已取消消息。
- `export_html` 读取所有 canonical Entry、main leaf 与 label facts；HTML 是外部派生产物，不写入 Session。
- Tool、Model 和 thinking level 只能在 Driver 空闲时修改，新值进入下一次版本化 request configuration anchor。
- `set_model` 输入兼容旧字段 `modelId`，内部统一规范化为 `model`；RPC 配置变更会同步给后续 Session replacement 的 Runtime factory。
- `navigate` 的摘要选项与 TUI 使用同一个 durable navigation Operation 和恢复边界。`switch_session`、`fork_and_switch` 与 `clone` 依赖 CLI/SDK 提供 `CodingRuntimeHost`，普通单 Runtime RPC Session 会明确拒绝。
- Session 路径按当前活动 Runtime 的 cwd 解析；跨项目切换后，相对路径不会退回进程启动目录。
- `get_session_stats` 的历史总量覆盖已压缩和废弃分支；`contextUsage` 只描述当前 Projection，Compaction 后首次新回复前 token 数为 `null`。
- prompt template 在 Controller 输入边界展开；RPC `prompt` 与 `invoke_command` 都将展开后的文本持久化到 run intent，恢复不重新读取模板文件。
- `get_available_models` 与 `cycle_model` 遵守启动时 scoped-model pattern；`cycle_model.data.isScoped` 明确当前目录是否受限。
- Extension UI dialog 支持 AbortSignal 与 timeout；Runtime replacement、stdin 关闭或 shutdown 会取消悬挂请求并返回各方法的安全默认值。

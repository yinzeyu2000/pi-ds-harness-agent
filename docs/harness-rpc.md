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

## 命令

| 命令 | 关键字段 | 行为 |
|---|---|---|
| `prompt` | `message` | 空闲时启动新 run，立即确认受理 |
| `steer` | `message` | 向当前 run 的 steer 队列写入消息 |
| `follow_up` | `message` | 向当前 run 的 follow-up 队列写入消息 |
| `abort` |  | 中止当前 run |
| `resume` |  | 恢复 canonical Session 中可恢复的未闭合 run |
| `compact` | `customInstructions?` | 执行 durable compaction |
| `get_snapshot` |  | 返回 Runtime 与 Session 投影 |
| `get_messages` |  | 返回当前分支的模型消息 |
| `get_recovery` |  | 返回恢复分类 |
| `get_tree` |  | 返回所有 Entry 与 lane pointer |
| `navigate` | `entryId` | 原子移动 main lane 并重建 Driver 上下文 |
| `fork_session` | `sessionId?`, `entryId?`, `position?` | 从当前分支原子创建新的 JSONL Session 文件 |
| `switch_session` | `sessionId` | 事务式创建替代 Runtime、释放旧 Scope 并切换 Session |
| `fork_and_switch` | `sessionId?`, `entryId?`, `position?` | Fork 后立即通过 Runtime Host 切换 |
| `get_commands` |  | 列出 Extension 命令 |
| `invoke_command` | `name`, `args?` | 执行 Extension 命令并 flush 其 durable 动作 |
| `set_session_name` | `name` | 设置 canonical Session 名称 |
| `set_active_tools` | `names` | 空闲期切换下一次请求使用的工具 |
| `set_model` | `provider`, `model` | 空闲期切换模型 |
| `set_thinking_level` | `level` | 空闲期切换 thinking level |
| `approval_response` | `requestId`, `decision`, `reason?` | 回答工具审批；decision 为 `allow` 或 `deny` |
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
- Tool、Model 和 thinking level 只能在 Driver 空闲时修改，新值进入下一次版本化 request configuration anchor。
- `navigate` 不执行分支摘要；带摘要导航尚未进入 Harness RPC。`switch_session` 与 `fork_and_switch` 依赖 CLI/SDK 提供 `CodingRuntimeHost`，普通单 Runtime RPC Session 会明确拒绝。

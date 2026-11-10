# B：持久研究旁支后端

基线：`3a27d78c`。范围仅 Rust 后端及本文；不包含前端、历史定位 C、文件恢复 D。

## 接口契约

Tauri 命令与 HTTP `POST /api/<命令名>` 使用同一核心实现，JSON 参数 camelCase。

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `research_branch_create` | `{connectionId, sourceConversationId, requestId}` | `ResearchBranchInfo` |
| `research_branch_list` | `{conversationId}` | `ResearchBranchInfo[]` |
| `research_branch_save_summary` | `{branchConversationId, summary}` | `ResearchBranchInfo` |
| `research_branch_generate_summary` | `{branchConversationId, requestId}` | `{summary}` |

`ResearchBranchInfo`：`id:number`、`sourceConversationId:number`、
`branchConversationId:number`、`sourceSessionId:string`、`branchSessionId:string`、
`sourceTurnId:string|null`、`boundary:'session_tail'`、`title:string`、
`sourceTitle:string`、`summary:string`、`createdAt:string`（RFC3339）。

`requestId` 为 1–128 个 ASCII 字母、数字、`-` 或 `_`。
创建重试必须沿用同一个 requestId；不同源会话复用 requestId 返回冲突。
已完成请求直接返回原关系，不依赖旧 connectionId 是否仍在线。

错误沿用 `AppCommandError`。忙门控使用 `TurnInProgress`（HTTP 409），
`detail` 含 JSON `acpCode:'turn_in_progress'`，不新建 i18n 项。
不存在或已软删除的请求目标返回 `NotFound`（HTTP 404）。
list 查询活会话时过滤另一端已删除的关系；summary 任一端删除均为 NotFound。

## 创建及连接生命周期

1. 按 requestId 串行，先查持久幂等记录和恢复日志；忙请求不排队到主线下一轮。
2. `try_lock_owned` 持有源连接 prompt_lock，校验 idle、selectors_ready、fork_supported、
   主 DB 行/外部 session/agent/cwd。普通 regular/chat 可创建，delegate/loop 拒绝。
3. 只读解析源 transcript，记录最新助手 turn ID；不调用可能顺带更新主行的普通 detail。
4. 通过单独的 spawn 路径跳过 resume 去重，创建 `research_branch` owner 临时 ACP 连接。
   emitter 为 Noop，不绑定 conversation，不发送 prompt，不接管主输出，也不启用提示建议。
   临时连接使用源 agent/cwd/当前 mode/config 和正常代理运行环境；仅它可执行 native fork。
5. spawn 返回不表示 ready。等待 Connected + selectors_ready，再验证 runtime fork 能力和
   resume 后的 session ID 仍为 S1；适配器若回退新 session 则明确失败。
6. 再检查源状态，记录并 fsync pending 日志，然后仅向临时 cmd_tx 发送
   `ConnectionCommand::Fork { fork_point: None }`。源 cmd_tx 从不收到 Fork。
7. 研究 owner 的 fork 返回原生 S2 后直接退出临时连接，不运行普通 fork 的重连、
   SessionStarted 和 close-parent 逻辑。前端再用现有 resume 正常打开 S2。
8. 会话新行与研究关系在同一事务提交；源会话行完全不写入。
   新行沿用 regular/chat，parent_id/委派字段为空，source 为 research，title_locked 为 true。
   事务成功只广播旁支会话 upsert，不改主会话 ID、历史、连接或输入草稿。

整个 fork/持久化在取消屏蔽的独立 Tokio 任务内运行。
HTTP/Tauri 调用方消失不打断已提交的 fork，重试使用相同 requestId 取回结果。
ready 和 fork 响应分别有 120 秒上限；临时连接 Drop 清理，握手取消后断开，
必要时用已有 PID cell/kill-tree 机制仅回收本次临时进程，不操作主连接或既有 Web。
即使 driver 已退出并移除连接 map，仍保留原 PID cell 等待回收，避免立即 resume S2 时
撞到尚未释放的临时进程写锁。

## 原子性、补偿及重启

新增 migration `m20261110_000001_research_branch` 与独立 SeaORM entity/service。
表包含唯一 request_id、唯一 branch_conversation_id、两端会话 ID、两端原生 session ID、
来源 turn、边界、摘要和创建时间。绝不借用 conversation.parent_id。
创建与摘要更新事务先对研究表执行空 UPDATE 取得 SQLite 写锁，避免 deferred
SELECT→写入升级的 BUSY_SNAPSHOT，并且不借此修改源会话时间戳。

ACP 没有通用且已在本项目接入的跨代理 session delete，不能声称自动删除原生 S2。
采用 `<data_dir>/research-branch-recovery/<sha256(requestId)>.jsonl` 补偿日志：

- native fork 前写入并 fsync pending，成功后 append 并 fsync 包含 S2 的完整记录。
- fork 成功但 DB 失败：不留可见 conversation 半行，保留 S2 记录；同 requestId 重试
  只执行 DB 事务，不再 fork。该恢复可以跨应用重启，不依赖内存关系或旧连接。
- DB 成功但调用方取消：关系已持久化，同 requestId 返回原结果。
- DB 成功后日志删除失败：仍算成功，以 DB 幂等记录为准。
- pending 后进程崩溃、RPC 超时或响应通道消失：结果可能未知；同 requestId 明确拒绝
  重 fork，要求排查恢复记录，不以静默全文复制或新 fork 掩盖不确定性。
- 发送通道已关闭或忙门控明确在 RPC 前拒绝时可清 pending；一般协议/传输错误也保留
  pending，因为远端可能已创建 S2。磁盘持久化异常返回错误及可用 S2 身份，不能承诺跨远端
  fork 和本地文件/SQLite 的分布式原子提交。

一般关闭、断线、重启使用既有 conversation resume/cleanup：旁支 external_id 指向 S2，
关联表跨重启保留；删除一端不级联删除另一端。两端软删除过滤，不复活已删除请求。

## 摘要

手动保存接受空草稿或最多 12000 个 Unicode scalar 字符，原样持久保存，
不 trim、不写主会话、不自动发送。list 和 summary 返回现存标题。

generate 从旁支解析正文，拒绝当前忙的旁支，取最多最近 12 段 user/assistant 正文、
合计 12000 字符；不包含 system、thinking、工具调用或工具输出。
只保留到最后一个有完成时间的助手回复，未闭合助手正文和尾部待答用户消息不进入快照。
没有可确认完成的助手正文时明确拒绝，不将半截输出当作研究结论。
快照阶段持有匹配旁支连接的 prompt_lock，形成后释放，不占用主连接。
复用现有 `side_question::ask`，因此使用无工具 Claude one_shot、side_question settings、
独立请求 token 和 `side_question_cancel({requestId})`。窗口关闭取消摘要生成。
生成结果只返回 `{summary}`，不自动保存编辑稿，不自动进入主输入框；
需要用户显式 save_summary，带回主线由前端另做手动草稿动作。

## 验证与验收

新增针对性 Rust 测试：

- 关系双向查询、源行不变、parent_id/委派字段不污染、regular/chat 继承和标题锁定。
- requestId 幂等、跨源复用冲突、重复创建会话数不增长。
- SQLite trigger 强制关系写失败后 conversation 插入整事务回滚，再次提交能成功。
- 摘要 Unicode 上限、持久编辑稿及任一端删除后的 list/summary/notfound。
- idle/忙/能力/ready 门控、请求锁隔离、恢复日志 pending/成功记录、安全文件名。
- 有限正文快照 Unicode 截断、最新 12 段、系统消息排除及缺失连接零插入。
- runtime ready/capability/源 session 身份、临时连接不可复用及 cleanup 不能误断主连接。
- 恢复日志中已有 S2 时无源连接也可完成事务并保持幂等。
- 关闭并重新打开磁盘 SQLite 后关系和手动摘要仍可查询。

后端委派阶段只执行新文件格式和已有文件语法检查，未自行启停服务。
主代理整合后已统一在 Herdr 中执行并通过以下验证：

```text
cargo test --no-default-features --features server-bin --lib research_branch -- --test-threads=2
cargo build --no-default-features --features server-bin --bin codeg-server
cargo clippy --no-default-features --features server-bin --bin codeg-server --lib -- -D warnings
```

旁支 13 项测试、既有 fork 79 项和 one-shot 9 项均通过。
桌面 `cargo check` 也通过，临时跳过 sidecar 拷贝以避开测试 Web 文件占用。

Ego 在本机 Claude ACP `0.98.0` 完成原生 S1→S2、主详情逐字不变、旁支独立问答、
摘要生成及草稿回填、取消、忙门控、幂等重试、后端重启和关闭标签重开验收。
Codex/DeepSeek 真实并行恢复尚未逐一认证；若适配器单写者锁拒绝临时 resume，
后端明确报错，不切换主连接或退化为全文复制。
完整证据见 `research-branches-b.md`。

# 会话旁问、历史分支与回退能力调研

核验日期：2026-11-10，Asia/Shanghai。

本地基线由主代理只读核验：`HEAD=9e2c6354`，已合并
`upstream/main=5c03d7af`，包版本 `0.42.1-local.1`。
官方最新正式发布为 `0.42.1`，发布时间为
`2026-11-06T23:38:38Z`，即北京时间 11 月 7 日 07:38。
上游更新已进入当前源码，不能把现有 fork 能力当作尚未开发。
来源：[官方 v0.42.1 发布](https://github.com/spacering-net/codeg/releases/tag/v0.42.1)、
[本次同步的官方提交](https://github.com/spacering-net/codeg/commit/5c03d7af865f54cf42a994327daf2c45ab4a946f)。

本文核验公开官方文档、协议及固定版本适配器源码，并结合本地代码证据提出方案。
研究过程没有调用模型付费接口、启动真实代理会话或开发这些功能。
主代理另行完成了用户授权的源码同步：14 个上游新增提交，37 个文件，
无合并冲突；保留本地扩展和版本后缀。本次未生成或安装新的桌面安装包。
文档中的“源码支持”不等于已经通过 Codeg 端到端实测。

## 结论与建议

1. **难点主要在语义与会话生命周期。** Codeg 已有 fork、按回答定位、
   独立标签和分屏。旁问仍需独立的请求、状态、存储及输出路由；
   现有 fork 会切换主连接的目标会话，不能直接拿来做“主线继续、侧边旁问”。
2. **先做轻旁问，再做持久旁支及历史继续。** 轻旁问可用所选文字加明确标注的
   有限上下文；持久旁支必须是真实独立会话，原会话继续可用，结果由用户手动带回。
   这两种模式不能在界面里混称为同一种完整上下文 fork。
3. **历史继续采用新建分支。** 保留原会话，从已确认的历史边界创建另一个会话。
   无法确认边界时应拒绝或明确提示；不能静默变成尾部 fork 后显示“已回到这里”。
4. **对话回退与文件回滚单独设计。** fork 和历史导航通常只改变模型上下文。
   文件恢复需要独立的快照、覆盖范围和冲突处理；本期不承诺跨代理工作区还原。
5. **能力分三层验收。** 原生 CLI/SDK、ACP 适配器、Codeg 客户端是三层。
   原生能力更强、同名社区包更强、协议存在某个方法，都不能直接算作 Codeg 已支持。

## 原生与协议能力核验

### Claude Code

| 能力 | 已核验行为 | 对 Codeg 的含义 |
| --- | --- | --- |
| `/btw` | 使用当前对话已有信息，无工具、不打断主轮次、不写入主会话历史；后续旁问会看到最近 20 次旁问交换 | 可参考其交互语义；不能用普通可调用工具的 fork 冒充同等只读旁问 |
| 旁问保存 | 终端旁问存在内存中，退出丢失；VS Code 的旁问面板可跨窗口重载保留 | “旁问天然不保存”不是所有官方界面的统一语义 |
| `/branch`、CLI `--fork-session`、SDK `forkSession` | 创建新的会话 ID，保留原会话；SDK 的 fork 只分叉对话历史 | 可用于持久研究分支，但不会自动隔离同一目录里的文件修改 |
| `/rewind` | 可选择恢复对话、恢复代码或两者恢复，也可定向压缩上下文 | 原生界面的功能不能直接映射成 Codeg 已有 ACP rewind |
| SDK `rewindFiles()` | 需要开启文件 checkpoint 并保存 checkpoint UUID；只恢复文件，不回退会话 | 文件恢复要单独接入并验证，不能拿 fork 的会话 ID 代替文件快照 |

来源：[Claude Code — Side questions with /btw](https://code.claude.com/docs/en/interactive-mode#side-questions-with-%2Fbtw)、
[Manage sessions — Branch a session](https://code.claude.com/docs/en/sessions#branch-a-session)、
[Agent SDK — Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions#fork-to-explore-alternatives)、
[Checkpointing](https://code.claude.com/docs/en/checkpointing)、
[Agent SDK — File checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing)。

文件 checkpoint 的覆盖也有限：没有被主会话文件工具纳入跟踪的 shell 修改、
不少子代理修改、目录操作及外部并发修改不能一概还原。
来源：[File checkpointing — Limitations](https://code.claude.com/docs/en/agent-sdk/file-checkpointing#limitations)。

### Codex

官方当前文档已经有 `/side`，别名 `/btw`：从当前会话创建临时 fork，
侧聊 transcript 与父会话分开，仍显示父会话运行状态；不支持在侧聊里再套侧聊，
review 模式也不可用。另有 `codex fork`、`codex exec fork` 和 `/fork`
创建新会话。**这些是当前原生产品能力，本文未把它们认定为 Codeg ACP 已暴露。**
来源：[Codex — Developer commands](https://learn.chatgpt.com/docs/developer-commands#start-a-side-chat-with-side)。

App Server 的当前官方契约有两项关键区别：

- `thread/fork(threadId, lastTurnId)` 新建线程并保留到目标 turn，包含该 turn；
  不能指定仍在进行中的 `lastTurnId`。因此即使界面选中的是一条回答，
  截断边界仍可能是完整 turn。
- **`thread/rollback` 已移除**，调用会返回 unknown-method。
  现在是 `thread/revert(beforeTurnId)`：移除目标 turn 及其后历史，
  仅支持持久化、分页历史的线程，不支持 ephemeral 或 legacy history，
  也不恢复本地文件。不能继续把旧 `rollback(numTurns)` 当作当前通用接入方案。

来源：[Codex App Server — Start or resume a thread](https://learn.chatgpt.com/docs/app-server#start-or-resume-a-thread)、
[Revert thread history](https://learn.chatgpt.com/docs/app-server#revert-thread-history)。
官方同时说明生成的 schema 与所执行的 Codex 版本绑定，所以实际适配时仍需核对
适配器携带的运行时，不能只照最新版网页调用。
来源：[Codex App Server — Message schema](https://learn.chatgpt.com/docs/app-server#message-schema)。

### Pi

Pi 原生会话是树：`/tree` 在同一个会话文件中切换位置并保留旧分支；
`/fork` 从较早用户消息创建新会话；`/clone` 复制当前活动分支。
模型只收到活动分支，不会把文件内所有分支都放进上下文。
来源：[Pi — Sessions and Context](https://github.com/earendil-works/pi/blob/815541a146e7123bba4942a181eb09b61cb99455/packages/coding-agent/docs/sessions.md)。

原生 RPC 也有 `fork(entryId)`、`clone`、`get_fork_messages` 和 `get_tree`。
`fork` 可被扩展事件取消，命令处理成功不代表已完成后续模型工作。
来源：[Pi — RPC Commands](https://github.com/earendil-works/pi/blob/815541a146e7123bba4942a181eb09b61cb99455/packages/coding-agent/docs/rpc-commands.md)、
[RPC Mode](https://github.com/earendil-works/pi/blob/815541a146e7123bba4942a181eb09b61cb99455/packages/coding-agent/docs/rpc.md)。

这些是上下文/会话能力；本次资料不能证明 Pi 自带跨代理文件 checkpoint，
也不能证明 Codeg 当前固定的 `pi-acp` 已桥接这些 RPC。

### DeepSeek Harness

已找到一手官方仓库 `deepseek-ai/deepseek-harness`，确认是 DeepSeek 的 Harness，
官方 README 仍标注 developer preview 和兼容性可能破坏。
来源：[DeepSeek Harness 官方 README](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/README.md)。

但 Codeg 固定包是 **`deepseek-acp@0.9.0`，仓库为 `xintaofei/deepseek-acp`**，
其 README 明确写明社区适配器、非 DeepSeek 官方。
它的 `session/fork` 及历史恢复应按这个版本的实现验收，
不能拿官方自动化 ACP 或另一个 `@openma/deepseek-harness-acp` 的功能替代。
来源：[npm 0.9.0 元数据](https://registry.npmjs.org/deepseek-acp/0.9.0)、
[固定版本 README](https://github.com/xintaofei/deepseek-acp/blob/c325d134ed7502e727bd9c6cffcc2a05dff70104/README.md)。

固定版本 `fork-point.ts` 已实现助手消息 ID、文本 SHA-256、重复次数匹配；
真实截断点是该消息所在回合的 `turn/end`，整个回合必须已闭合。
未找到目标、回合未闭合，或“逐消息/逐回合”指纹分别命中不同回合时会拒绝。
因此可支持历史分支，但不能承诺精确到多步 turn 内任意一句话。
来源：[deepseek-acp 0.9.0 — fork-point.ts](https://github.com/xintaofei/deepseek-acp/blob/c325d134ed7502e727bd9c6cffcc2a05dff70104/src/session/fork-point.ts)。

本次没有独立实测官方 Harness 的原生回退及文件恢复，
不据社区适配器推断官方所有界面具有同等能力。

### ACP

| 接口 | 当前核验状态 | 必须检查的条件 |
| --- | --- | --- |
| `session/load` | v1 稳定接口，恢复上下文并回放历史 | `agentCapabilities.loadSession` |
| `session/resume` | 2026-04-22 已稳定；恢复会话但不回放历史 | `sessionCapabilities.resume` |
| `session/fork` | 仍在 fork RFD/unstable 接口范围；基础请求不含历史消息锚点 | `sessionCapabilities.fork`，再验证具体适配器的锚点扩展 |
| rewind/rollback | 本次所读稳定 v1 schema 没有统一会话回退方法 | 只能按具体扩展核验，不能由 load 或 fork 能力推导 |

来源：[ACP — Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup)、
[Session Resume is stabilized](https://agentclientprotocol.com/announcements/session-resume-stabilized)、
[Forking of existing sessions](https://agentclientprotocol.com/rfds/session-fork)、
[v1 Schema](https://agentclientprotocol.com/protocol/v1/schema)。

fork 的 RFD 明确：新会话在 fork 响应后已经可用，可直接 prompt，
不必再次 load/resume；从历史消息定位仍需额外契约。
当前 Codeg 的 `Cargo.toml` 使用 `agent-client-protocol = 3.4.0`，
显式启用 `unstable_session_fork`，没有启用 `unstable_protocol_v2`。
“协议支持”与“本次连接协商成功”仍需分开。
来源：[fork RFD](https://agentclientprotocol.com/rfds/session-fork)、
[本地 Cargo.toml](../../src-tauri/Cargo.toml)。

## Codeg 固定适配器：可承诺到什么粒度

以下 npm 版本、仓库及 `gitHead` 通过对应发布包元数据核验，
用于避免把不同来源、不同版本的同名适配器混在一起。
没有执行安装或升级。

| Codeg 固定包 | 已核验的底层能力 | Codeg 当前边界 |
| --- | --- | --- |
| `@agentclientprotocol/claude-agent-acp@0.102.0` | AIR fork 可按助手消息 ID 定位，查活动历史及已保存其他分支，指纹作为回退匹配；保留到该消息 | 本地 resolver 已为 Claude 生成锚点，但未验证全部真实历史样本 |
| `@agentclientprotocol/codex-acp@2.6.0` | AIR fork 将消息 ID/指纹解析到 turn，再调用 `threadFork({lastTurnId})` | 回答定位最终是完整 turn；不能展示为任意字符/任意流式片段回退 |
| `deepseek-acp@0.9.0` | 社区适配器支持消息锚点；截到所属已闭合回合末尾 | 需要 ID 与本地聚合文本口径一致；歧义不能自动选择 |
| `pi-acp@0.0.34` | `svkozak/pi-acp` 的 initialize 只声明 load、list、delete，没有 fork | Pi 原生有 fork，但这条固定 ACP 路径不能据此启用历史 fork |

来源：
[Claude 发布元数据](https://registry.npmjs.org/@agentclientprotocol%2fclaude-agent-acp/0.102.0)、
[Claude 固定版 AIR 契约](https://github.com/agentclientprotocol/claude-agent-acp/blob/8e18eb7c75fb6fe07890ad2f639e515d29ab62a2/docs/air-extensions.md#session-fork-point)、
[Codex 发布元数据](https://registry.npmjs.org/@agentclientprotocol%2fcodex-acp/2.6.0)、
[Codex 固定版 SessionFork.ts](https://github.com/agentclientprotocol/codex-acp/blob/f3208913693bd4d5171d6c6b9be5ec1ff96c6431/src/SessionFork.ts)、
[DeepSeek 发布元数据](https://registry.npmjs.org/deepseek-acp/0.9.0)、
[DeepSeek 固定版 fork-point.ts](https://github.com/xintaofei/deepseek-acp/blob/c325d134ed7502e727bd9c6cffcc2a05dff70104/src/session/fork-point.ts)、
[Pi 发布元数据](https://registry.npmjs.org/pi-acp/0.0.34)、
[Pi 固定版 agent.ts](https://github.com/svkozak/pi-acp/blob/b0581c9c1d675e634234674484247008b03d69b4/src/acp/agent.ts#L236)。

版本提示：Codex 适配器声明依赖 `@openai/codex ^0.166.0`；
Claude 适配器声明依赖 Agent SDK `0.3.321`。
这仅证明发布元数据，不证明本机实际解析到的嵌套运行时版本。
本地 `fork.rs` 的部分说明提到的是较早版本，能力结论以上述固定版实现为准。

AIR 锚点属于 `_meta.jetbrains.air.fork` 实验契约。
三家适配器的出错和降级细节也不完全一致：例如 Claude 的版本/空 ID 不符合
识别条件时可能忽略该块并全量 fork，Codex 对空 ID 会拒绝。
客户端应先校验锚点并记录实际粒度，不能把 `supportsFork` 一个布尔值当作精确度证明。
来源：[Claude AIR 契约](https://github.com/agentclientprotocol/claude-agent-acp/blob/8e18eb7c75fb6fe07890ad2f639e515d29ab62a2/docs/air-extensions.md#session-fork-point)、
[Codex AIR 契约](https://github.com/agentclientprotocol/codex-acp/blob/f3208913693bd4d5171d6c6b9be5ec1ff96c6431/docs/air-extensions.md#session-fork-point)。

## 本地实现与方案影响

以下代码位置由主代理核验；本研究补核了 `fork.rs` 和固定包来源。

| 已有实现 | 已确认行为 | 方案影响 |
| --- | --- | --- |
| `conversation-detail-panel.tsx:1395`、`:2174` | 已有 `handleForkFromTurn`，入口受 `conn.supportsFork` 控制 | 复用 UI 入口及错误处理，补充能力粒度 |
| `acp/fork.rs:109` | Claude、Codex、DeepSeek 可生成历史回答锚点；其他代理返回 `None` | 无锚点会走尾部 fork；不能将其当作历史定位成功 |
| `acp/manager.rs:2291`、`:2564` | 现有 fork 复用并切换当前连接；DB 当前记录改为新会话，原会话另存 sibling | 旁问需新的非破坏 fork/独立连接路径，不能直接复用当前命令 |
| `acp/manager.rs:2380` | 定位解析失败或找不到点时可能退化为尾部分支 | 历史继续必须取消静默降级或明确显示实际定位结果 |
| `tab-store.ts:1843` | `splitTab` 可把独立会话放入另一个分组 | 持久旁支可优先复用分屏与标签组 |
| `aux-panel.tsx`、`aux-panel-context.tsx` | 右侧栏已有会话详情、文件树、changes 等页签和可调宽度 | 短旁问可放侧栏；完整研究会话不宜直接嵌套整个主详情组件 |
| `conversation-detail-panel.tsx:1792`、`message-quote.ts:54` | 已有选中文字提问，只把所选文字与问题放入提示 | 可复用选择入口，不能描述为复制了完整上下文 |
| `acp/one_shot.rs`、`ai/context.rs:68` | 已有临时单问路径及有限上下文构造；上下文只取部分文本并有字符上限 | 可作轻旁问基础；现有仅 Claude 明确无工具，其他代理还需强约束 |

本地代码入口：
[会话详情](../../src/components/conversations/conversation-detail-panel.tsx)、
[消息引用](../../src/lib/message-quote.ts)、
[标签状态](../../src/stores/tab-store.ts)、
[fork 锚点](../../src-tauri/src/acp/fork.rs)、
[会话管理](../../src-tauri/src/acp/manager.rs)、
[单问路径](../../src-tauri/src/acp/one_shot.rs)、
[有限上下文](../../src-tauri/src/ai/context.rs)。

还需避免三个误用：

- 会话数据库的 `parent_id` 已承担委派关系，不能直接拿来表示研究旁支来源；
  新增独立 branch link，包含源会话、分支会话、锚点、边界类型和创建意图。
- `agent_turn_files` 是 Office 自动预览路径记录，轮次结束清理，
  没有文件历史版本，不能用作 checkpoint。
- `gitRollbackFile`、`rollbackToSnapshot` 分别是其他 Git/备份恢复路径，
  不等于代理上下文恢复。

## 建议分期与投入

这是经验推算，假设一位熟悉本仓库 Rust/React 的开发者，
包含核心回归，不包含所有代理、系统和认证方式的真实环境认证。
尚未做独立旁会话生命周期 spike，不能当作交付承诺。

| 阶段 | 交付范围 | 估算 |
| --- | --- | --- |
| A：轻旁问 | 选区/有限上下文、侧栏、独立加载与取消、明确上下文范围；从能硬性禁用工具的代理开始 | 2–4 人日 |
| B：持久研究旁支 | 原会话保持可用、独立子会话与关系记录、分屏、手动摘要带回、重连及清理 | 5–8 人日 |
| C：历史继续 | 复用已有锚点 fork，保留原会话，禁止未告知的尾部降级，展示 turn/message 边界 | 3–5 人日 |
| D：文件恢复 | 文件 checkpoint、代理覆盖差异、并发修改识别、预览及冲突撤销 | 另需 10–20+ 人日 |

实施记录：[A：轻旁问](side-questions-a.md)、
[B：持久研究旁支](research-branches-b.md)、
[C：从历史消息继续](history-continuation-c.md)。

B/C 共享连接和关系基础，不能直接相加。Claude、Codex、DeepSeek 先按能力门控，
Pi 另做适配验证；做到稳定日用版约 2–4 周是合理粗估。
A 的范围不包含“所有代理都严格无工具且拥有完整原生上下文”；
如果要求这一点，需先证明各适配器的工具隔离机制，再重新估算。

成熟度验收至少应覆盖：

1. 原会话正在输出时旁支请求的接受、排队或拒绝语义，不能偷走主输出；
   最低版本可明确等待已提交边界。
2. 重复文本、多步 turn、压缩历史、已放弃分支、空回答及失效 ID 的定位。
3. 旁支取消、错误、断线重连、应用重启后关系恢复；`fork` 成功但 DB/标签失败的清理。
4. 摘要只经用户选择后进入原会话，旁问内容不自动进入主历史。
5. 测试和界面都区分“有限文本旁问”“消息分支”“完整 turn 分支”“文件恢复”。

建议先以 A 验证用户是否真的需要短旁问，再补 B/C。
不必以完整树形 UI 作为首期前提。

### 推荐的使用流程

结合此前“先调研、带回 summary、主线继续开发”的目标，建议：

1. 在主会话的已完成回答上选择“旁聊调研”，固定来源边界和上下文范围。
2. 右侧打开独立会话；长研究可以切换为现有右分屏。
   主线保留自身的会话 ID、输入草稿和输出路由。
3. 研究结束后提供“整理结论”，展示可编辑的摘要草稿。
4. 用户选择“带回主线”时才将摘要放入主输入框；主线忙时由现有队列处理。
   旁聊全文和工具输出不自动并入主历史。
5. 若用户已经在主线完成了调研，再使用“从此处继续”新建历史分支，
   保留原完整会话，并显式带入用户选择的研究摘要。

这一流程既覆盖短旁问，也覆盖持续调研；文件恢复仍是单独操作。
首期可用“来源回答 + 旁聊列表 + 返回主线”导航，不要求完整树形视图。

## 本次验证与剩余不确定性

- 已完成：官方页面正文核验、npm 固定发布元数据核验、四个固定适配器的相关契约/
  源码核验、本地实现边界复核。功能调研仅新增此 Markdown，尚未实施。
- 未完成：本机安装版本探测、真实 provider 请求、并发 fork/恢复及文件恢复实测。
  其中不同适配器对源会话写锁、主轮次进行中 fork 的行为仍需最小实验。
- 研究时部分网页提取被导航或长正文截断，改读同一官方站点的 Markdown
  或固定 commit 原文；没有以搜索摘要作为最终契约依据。

源码合并后，主代理完成以下验证：

| 检查 | 结果 |
| --- | --- |
| 受影响的前端测试：`agent-row`、`background-overlay`、`acp-connections-context`、`use-connection-lifecycle`、详情布局 | 5 个文件，341 项通过 |
| `node --no-experimental-webstorage node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --incremental false` | 生产类型检查通过 |
| `cargo test --no-default-features --features server-bin --lib fork -- --test-threads=2`（`src-tauri/` 下） | 78 项通过；编译了服务器模式的库测试目标 |
| `git diff --check HEAD^1 HEAD`、上游祖先检查 | 通过，官方 `5c03d7af` 已包含于本地分支 |
| 全量 `tsconfig.json` 类型检查 | 未通过：`.next/dev` 生成类型的未使用导入，以及既有 `prompt-stash-settings.test.tsx` 的 `ByRoleOptions.exact` 错误 |

上述测试文件在合并前后的 Git blob 相同，相关错误不在本次上游修改范围，
本次未修复这些既有问题。没有运行桌面打包，也没有将源码验证等同于
新功能或所有代理的真实环境验收。

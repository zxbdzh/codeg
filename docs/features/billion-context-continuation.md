# billion-context 压缩后的续接

## 问题证据

2026-11-11 核对本机 billion-context 0.1.213 与 Claude Code 原始 JSONL。
11:55 的助手消息只有一段 `[Compressed ...]` 回执，`stop_reason=end_turn`；
Codeg 日志随后记录同一父连接 `turn_complete ... stop_reason=end_turn`。
当时独立 Codex 子任务仍在运行；父连接并没有断开。

已安装 Bili 的 `dist/index.js` 会消费模型请求的压缩工具调用，将结果改为
Anthropic `text` 块；当响应中没有剩余真实工具调用时，将 `stop_reason`
改为 `end_turn`。这条路径没有发送 Agent Client Protocol 的
`compaction_update`，因此 Codeg 原来的标准压缩适配不会接管它。
Bili 所说 ACP 是 Active Context Pruning，与 Agent Client Protocol 是不同概念。

## 适配行为

- 当前针对已核实的 Claude Code 路径。只识别 Bili 成功压缩回执的完整头部、
  数值、消息区间和固定指纹说明；引用、普通说明和未知格式仍显示为正文。
- 缓冲疑似回执的流式分片，最多 64 KiB；完成后复用现有压缩卡片，
  不将内部指纹说明当作助手正式回答。重新打开历史时也显示为卡片。
- 回执以正常 `end_turn` 结束时，在同一会话内补内部续接请求，
  继续最近真实用户任务；保持原执行轮次和取消入口，最终回答后才广播完成。
- 不重复发送用户原话。内部续接记录不作为用户消息展示，
  不新增用户历史分叉边界，也不覆盖输入框草稿。
- 用户取消、失败、拒绝、未识别输出、手动 `/compact`、`/compress`、
  `/clear` 不自动续接。已排队的新操作优先，避免取消与结束同时到达时多发请求。
- 一次用户执行最多自动续接三次，同一个回执不重复续接。
  达到限制时提示用户，而不是形成无限请求。

## 验证边界

原始问题有只读记录回放；修复后的识别器直接重放同一段真实回执。
协议测试使用内存 ACP 代理，不调用付费模型，也不重放生产任务。
不能据此宣称其他 Bili 版本、Codex/DSH/Pi 的运行路径已完成真实认证。

2026-11-11 验证结果：

- 同一条真实回执按字符分片回放，识别到 2 个块、节省 5826 token，
  仅续接一次且没有将回执输出为正文。
- 新增 12 项回归通过：含真实 ACP 连接驱动的内存协议测试、
  原轮次取消、手动压缩、流式边界、重复限制和历史回放。
- 原有压缩相关筛选回归 46 项通过。
- 服务器模式 `cargo clippy --locked --no-default-features --features server-bin
  --bin codeg-server --lib -- -D warnings` 通过，新模块格式和补丁空白检查通过。
- 未对生产会话自动发送消息，未修改 Bili 配置，未调用付费模型。
  此次源码改动尚未提交，也未纳入此前生成的安装包。

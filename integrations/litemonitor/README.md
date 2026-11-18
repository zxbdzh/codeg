# Codeg 任务哨兵

LiteMonitor 插件，在一个紧凑条目内显示 Codeg 的运行数和近 15 分钟完成数。
有待授权时追加提示并变为警告色，无待授权时收起提示，不占用额外监控列。

```text
Codeg  运行 7 · 完成 3
Codeg  运行 7 · 完成 3 · 待授权 1
```

默认每 5 秒刷新，每次只请求一次接口，同时更新三个计数。
刷新间隔可在 LiteMonitor 中调整，最小为 2 秒。

## 安装与配置

1. 将 `CodegSentinel.json` 复制到 LiteMonitor 安装目录的
   `resources/plugins/` 文件夹。
2. 在 Codeg 的设置中开启 Web 服务，记下服务端口并复制访问令牌。
3. 重启 LiteMonitor，或使用当前版本提供的重载插件功能。
4. 在 LiteMonitor 的插件管理中找到「Codeg 任务哨兵」，填写：
   - **Codeg 服务地址**：本机默认是 `http://127.0.0.1:3080`；
     若修改过端口，请替换 `3080`，地址末尾不要加 `/`。
   - **Codeg 访问令牌**：填写 Codeg Web 服务的访问令牌。
5. 启用插件并保存，在监控项设置中选择「Codeg 任务」的桌面及任务栏可见性。

从 1.0 升级时，保留原「运行」监控项的可见性和排序。
重载插件并保存配置后，旧「待授权」「错误」独立监控项会被移除。

连接远程 Codeg 时，将服务地址改成对应的 HTTP 或 HTTPS 地址。
插件模板不携带令牌；访问令牌只填在本机 LiteMonitor 配置中。

## 计数规则

插件复用 Codeg 的 `POST /api/pet_list_active_sessions` 接口，
读取 `runningCount`、`waitingCount`、`completedCount`，不自行推测会话状态。

- 待授权会话优先计入「待授权」，不会同时计入「运行」。
- 正在工作的委派子智能体由主会话代表，避免父子会话重复增加运行数。
- 子智能体等待权限批准时，会单独计入「待授权」，避免遗漏后台阻塞。
- 「待授权」特指权限请求，不包含一般提问、计划审批或已完成待查看。
- 「完成」统计滚动 15 分钟内正常结束的主会话任务：每正常结束一轮计 1，
  同一会话完成多轮会分别累计；取消、失败、重复结束事件、委派子智能体不计入。
- 完成记录由 Codeg 保存；关闭会话或重载 LiteMonitor 不会清零，
  满 15 分钟自动过期。当前记录保存在进程内，重启 Codeg 会重新开始统计。
- 「运行」「待授权」是当前状态，未接入 Codeg 的独立 Agent 不在统计范围内。

完成计数需要包含本次后端改动的 Codeg 版本。
连接旧版 Codeg 时，「完成」显示 `—`，运行及待授权仍可用，不把未知数据伪装成 0。

## 连接异常

Codeg 未启动、Web 服务未开启、令牌错误或请求失败时，
LiteMonitor 会将条目替换为 `❌`，不会继续保留上一次的计数。
服务恢复后，后续成功刷新会自动恢复计数。

如果显示 `❓`、`⛔` 或持续显示 `❌`，先检查地址、令牌及 Codeg
版本是否提供上述接口。插件使用单步骤执行链校验字段是否存在，
缺少运行或待授权字段时按取数失败处理；旧版缺少完成字段时显示 `—`。

## 开发参考

- 插件格式：[LiteMonitor 插件开发指南](https://github.com/Diorser/LiteMonitor/blob/master/resources/plugins/PLUGIN_DEV_GUIDE.md)
- Codeg 接口：`src-tauri/src/web/handlers/pet.rs`
- 运行及待授权计数：`src-tauri/src/models/pet.rs`
- 15 分钟窗口：`src-tauri/src/acp/completions.rs`
- 正常完成事件记录：`src-tauri/src/web/event_bridge.rs`
- 主会话和子智能体筛选：`src-tauri/src/commands/pet.rs`

# 可安装的 Web App

Codeg 的 Web 版可以添加到手机主屏幕或电脑应用列表，以独立窗口打开。应用图标、启动地址、独立窗口声明和静态资源缓存沿用已有 PWA 配置。

## 安装

使用服务器地址打开 Codeg，进入「设置 → 常规 → 安装 Codeg」。

- 支持浏览器安装提示时，点击「安装应用」，在浏览器提示中确认。
- iPhone/iPad 使用 Safari 的「分享 → 添加到主屏幕」；如显示「作为 Web App 打开」，开启后添加。
- 其他浏览器没有直接安装按钮时，设置页会说明如何从浏览器菜单查找安装入口。
- 普通 HTTP 访问也会提供添加步骤：Android 从浏览器菜单选择「添加到主屏幕／添加到手机／安装和创建快捷方式」，iPhone/iPad 使用 Safari 的分享菜单。
- HTTP 下网页不能强制弹出标准 PWA 安装框。浏览器可能只提供主屏幕快捷方式，是否以独立窗口打开由浏览器决定；自动安装提示与 Service Worker 离线缓存需要安全上下文。本机 localhost 是浏览器认可的例外。
- 已在独立窗口运行时显示应用状态，不重复展示安装引导。

电脑或服务器仍须在线，才能发送对话、执行任务和访问项目文件。离线缓存负责加载界面，不能在手机上离线运行服务器端智能体。登录和权限沿用 Web 版，不在安装链接中附加访问令牌。

## 实现与边界

根布局挂载 `WebAppInstallProvider`，提前捕获 `beforeinstallprompt`，避免进入设置页时错过事件。安装提示只在用户点击后触发；一次事件只消费一次，重复点击不会重复弹出。取消后等待浏览器再次发出事件；拒绝或失败不标记为已安装。只有 `appinstalled`、独立窗口显示模式或 iOS standalone 状态确认应用运行状态。

安装按钮以浏览器实际发出的事件为准，不再额外用协议挡住浏览器已提供的能力。没有事件时显示与设备对应的手动步骤，HTTP 不再直接结束安装引导。手动添加不冒充已安装状态，也不修改浏览器的安全设置或跳转到未经配置的 HTTPS 地址。

依据：[PWA 安装条件](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)、[Chrome Android 主屏幕快捷方式](https://support.google.com/chrome/answer/15085120?co=GENIE.Platform%3DAndroid)、[Safari 添加主屏幕 Web App](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios)。系统安装对话框由浏览器控制，站内脚本没有替用户完成该步骤的通用 API。

`WebAppInstallSettings` 复用现有设置组件。安装入口位于常规设置，因为 Web 运行时隐藏服务器管理用的「Web 服务」导航。Tauri 桌面应用不显示浏览器安装入口。

根布局增加 Apple Web App 元数据。`public/manifest.json` 和 `public/sw.js` 的已有配置保持不变。浏览器安装资格和系统安装界面由浏览器控制，模拟安装事件只能验证应用内交互，不能代替真机安装确认。

## 验证

HTTP 补充验收（2026-11-13）：

- 安装组件新增普通 HTTP、Android 添加步骤、iPhone HTTP 指引，以及浏览器确实提供事件时的能力判断，组件共 12 项通过；连同手机工作区及既有常规设置、Service Worker 回归，共 11 个文件、112 项通过。
- Ego 使用真实局域网 HTTP 地址连接隔离服务器，确认 `isSecureContext === false`、无 Service Worker 能力，并读取到浏览器的 `not-from-secure-origin` 安装资格错误。Android 分支仍完整显示添加步骤，无虚假的一键安装按钮；HTTP 不再显示保证独立窗口打开的简介。
- Chromium 模拟 iPhone UA 后，320、390、430px 的 Safari 添加指引保持可见且无页面横向溢出。该检查只证明站内识别和指引，不证明已在 iPhone 上完成系统安装。
- 生产构建、TypeScript、相关 ESLint、格式及 10 种语言安装文案键一致性检查通过。脚本和结果保存在 `F:/tmp/ego/codeg-mobile-pane-20261113-acceptance/`。

2026-11-13：组件测试覆盖提前捕获事件、一次性提示、取消、失败重试、确认安装、iPad 桌面 UA、iOS standalone、普通 HTTP、桌面模式和卸载清理。连同常规设置与 Service Worker 的既有测试，共 3 个文件、31 项通过；ESLint、格式检查与生产静态导出通过。

无窗口 Chromium 在本机安全上下文中验收生产页面：320、390、430px 无横向溢出，应用清单解析成功，四个图标尺寸正确，Apple 元数据齐全，浏览器安装资格错误列表为空。模拟事件验证安装按钮仅调用一次、取消不显示已安装，以及安装完成后的状态更新。测试使用隔离的旧版后端，仅验证本轮前端，未发送模型请求。

Android/iOS 真机安装和主屏幕启动须在实际 HTTPS 地址上确认。移动端与 Web App 改动合并为 `0.43.0-local.2` 打包基线，升级本地版本号使 Web App 缓存按新版本更新；不改变官方 `0.43.0` 基线。

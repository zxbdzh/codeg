# Ego Web：成熟远程浏览器方案调研

日期：2026-11-16。范围：官方文档、官方源码及固定发行标签核查；没有安装候选产品、购买服务、修改线上实现或重启浏览器。

## 结论

1. 用户重载后仍反馈模糊，因此上一轮同机合成图指标不能作为现场清晰度验收通过的依据。当前高清版本已上线不等于用户体验合格。
2. 页面级产品首先对标 Browserless LiveURL、Browserbase Live View；可审查和按许可复用的页面级源码候选是 Steel Browser，但其官方仍标为 public beta。不能把三个产品都当成可直接连接现有 Ego 的通用播放器。
3. 文字清晰度策略优先参考 KasmVNC 和 Selkies：区域更新、静止后细化、实际像素/DPI适配、可协商的色彩保真，而不是单独继续提高 WebRTC 码率。
4. Neko 是成熟的共享远程浏览器参考，但主要采集 Linux/X11 应用或桌面；直接换成其容器会换掉当前 Windows Ego 的运行环境，不能当作不影响登录态的即插即用方案。
5. 本轮未找到官方明确保证同时满足以下全部条件的现成替换件：Windows、当前原版 Ego 及已有实际页面/登录态、每会话独立页面组、不激活用户窗口、手机交互、可嵌入 Codeg。此处是限定调研结果，不是断言不存在其他产品。

## 必须保留的项目约束

- Windows 原版 Ego，优先复用已运行实例和网站登录态，不擅自换浏览器或复制资料目录。
- 展示和操作真实页面，按 Codeg 会话隔离页面及接管范围；不是只把完整 Windows 桌面裁出一个矩形。
- 人工输入前暂停所属组，显式「交还 Agent」才恢复；Web 断开不交还，其他设备只读规则保留。
- 不抢系统窗口焦点、不注入日常桌面前台键鼠、不重启日常 Ego。
- 文件往返和原有 computer use 仍沿用已确认范围。
- 页面级集成是已确认需求。换成完整远程桌面，或要求每会话新建 Linux 浏览器，都属于需求变化，不能暗中实施。

## 候选对照

下表「适配判断」是基于公开架构和本项目约束的工程判断，不是已完成兼容测试。

| 项目 | 官方已确认能力及机制 | 与当前 Windows Ego 的差距 | 适配判断 |
| --- | --- | --- | --- |
| Browserless LiveURL | 可嵌入、人工接管/完成事件、精确 targetId、只读模式；默认 JPEG70，支持 PNG 无损帧；HTTPS 页面加同源 WSS 流。见 [S1]。 | 其自定义 CDP 命令由 Browserless 服务提供，不是普通 Chrome/Ego 原生命令；Cloud/Enterprise 文档能力不能直接等同免费镜像。 | 最值得学习的页面级交互与清晰度对照；采购或复用前分别确认版本、许可和外部浏览器接入。 |
| Browserbase Live View | 独立页 live URL、iframe 嵌入、点击输入滚动、只读展示、断连消息；文档明确手机键盘不正式支持。见 [S2]。 | 文档围绕其运行中的托管 session；没有证明可接本机已有 Ego，更没有披露到足以确认的底层视频编码方案。 | 产品交互标杆，不据此推断使用 WebRTC，也不当成本地 Ego 显示库。 |
| Steel Browser | Apache-2.0，自托管 API+UI、CDP/Puppeteer、实时 viewer；支持 Windows Chrome 路径及自定义可执行路径。UI 源码以 debugUrl iframe 展示。见 [S3]。 | 官方仍标 public beta；CDP 服务源码实际调用 puppeteer.launch，配置可执行路径不等于接管已运行实例和现有 profile。 | 页面级开源源码调查优先级高，但不能直接把 launcher 指向日常 Ego。 |
| n.eko | Docker/Linux 应用或桌面的 WebRTC 共享，多人观看/控制、持久 cookie 和房间管理；可连接宿主 X server。见 [S4]。 | 不是 Windows 单标签采集库；不保证本项目的后台精确标签和每会话隔离。其 README 的其他项目比较不作为其他项目能力的权威来源。 | 共享浏览器的成熟独立演示基线；当前约束下不直接替换。 |
| Selkies | Linux 原生、X11/Wayland、GPU/CPU 编码、浏览器端嵌入；当前默认 WebSocket，可选 WebRTC。2.2.1 固定标签设置包含 4:4:4 协商和静止画面 paint-over 参数。见 [S5]。 | Windows 原版 Ego 的窗口/标签采集不是其 Linux backend 的直接适用范围；4:4:4 取决于编码器与接收浏览器，不保证每个手机都可用；paint-over 高质量也不等于数学无损。 | 最值得学习的低延迟与文字质量平衡；需验证采集/编码替代面，不把服务整体搬进日常环境。 |
| KasmVNC | Linux Web 远程桌面/应用；1.5.2 文档确认分块自适应 JPEG/WebP、静止后无损更新、WebRTC UDP transit；另有 WebCodecs 视频模式。见 [S6]。 | Linux/X 显示会话，不是 Windows 现有 Ego 的单页适配器；WebRTC transit 与浏览器 video 媒体轨道是不同层次的表述。 | 清晰文字与静止细化的首要参考，不盲目只选全帧视频模式。 |
| noVNC | 可嵌入 HTML/JS VNC 客户端，兼容手机、Unicode剪贴板、TightPNG/ZRLE/JPEG/H.264 等编码，需要 VNC server及WebSocket或代理。见 [S7]。 | 客户端本身不采集浏览器标签；Windows 服务端如何采集、是否抢焦点、隔离及画质仍是另一套实现问题。 | 可做文字清晰度/交互基线，不是页面组路由的替代。 |
| Apache Guacamole | 浏览器客户端→Guacamole协议→guacd→RDP/VNC等服务；有嵌入开发API。见 [S8]。 | 远程桌面网关，不识别 Ego target；RDP 的 Windows 会话行为需另核，不能保证连接后仍是同一日常图形会话。 | 更适合通用桌面远控，不作为页面级需求默认方案。 |
| MeshCentral | Windows/Linux agent远控、浏览器桌面/文件/终端、可通过allowFraming等配置嵌入。见 [S9]。 | 是设备/桌面管理，不是每会话单页浏览器控制；系统输入可能干扰用户当前桌面，接入必须另验。 | 既有 computer use/远程桌面需求参考，不取代页面级链路。 |
| BrowserBox | 页面级嵌入、标签/导航API，官方列 Windows/macOS/Linux 及 WebRTC/WS fallback。当前仓库声明产品源码私有，开发/评估也需有效许可。见 [S10]。 | 不再是可按旧博客印象直接拿来改的开源项目；官方公开材料没有证明接已有 Ego 实例、profile和target。 | 商业页面级候选；不安装、不试付费、不将旧fork当成当前产品。 |

## 稳定发布与主分支要分开

- n.eko：官方 latest 指向 `v3.2.0`，发布于 2026-10-15 22:08:07 UTC。发行记录及固定 README 确认 WebRTC；本轮没有足够固定版本证据确认 4:4:4、无损或 paint-over，不能宣传这些能力。
- Selkies：官方 latest 指向 `2.2.1`，发布于 2026-11-04 08:05:45 UTC。发行记录和固定 README 确认 WebRTC，以及默认 WebSocket/可选 WebRTC。
- 只读 README/发布说明时，Selkies 的 4:4:4/paint-over 最初是未证实；继续读取 **2.2.1 固定标签 `src/selkies/settings.py`** 后，已核实该版本包含 `video_fullcolor`、`use_paint_over_quality`、`video_paintover_crf` 和 `use_css_scaling` 等设置。尚未运行验证具体 encoder/client 的实际效果，也不据配置字段推断全部实现无缺陷。
- KasmVNC 的能力结论采用标明 **Version 1.5.2** 的官方配置文档，而非仅依据 master README 中的新功能列表。

## 当前实现与模糊的关系

### 源码已确认

本项目当前链路仍为：

```text
Ego 指定 target 的 CDP JPEG88
→ 隐藏 target 中 JPEG 解码与 canvas
→ canvas.captureStream
→ 浏览器 WebRTC 编码/传输
→ 访问设备 video 显示
```

本地依据：`src-tauri/ego/broker.mjs` 的 `watchFrames`，以及 `src-tauri/ego/rtc.mjs` 的 `rtcSenderSource`。移除1080p二次缩放只能修复一项失真；原JPEG解码后再视频编码这一步仍在。

### 仅为待验证因素，不冒充现场根因

- 初始 JPEG 损失、后续视频编码量化、可能的色度抽样。
- 实际协商出的 codec/profile、接收端实际解码像素及设备能力。
- 源页面像素、CSS尺寸、devicePixelRatio与客户端显示尺寸不匹配，包含视频被缩小后的文字可读性。
- 静止画面是否仍有较高量化，而当前实现没有独立的无损静止细化策略。

本轮没有读取用户页面内容、获取手机状态或抓取现场流，因此不能断言现场一定是4:2:0、某个codec、网络或设备问题。

## 哪些经验值得采用

1. **以页面级产品作交互基线。** Browserless 明确允许 PNG 流；说明成熟方案并非都以 WebRTC 全帧视频为唯一清晰度路径。其文件/交还/target生命周期设计可借鉴，但不照搬对断连自动继续的语义。
2. **以文字远程桌面作画质基线。** KasmVNC 文档明确说明滚动中可降低质量、停下后无损更新；Selkies 提供静止细化和按编解码能力选择色彩模式。不能将这些机制简单等同于“再加一个让用户选的通道”。
3. **区分网络与编码。** Selkies 默认WebSocket仍定位低延迟，Browserless LiveURL使用WSS；实际体验取决于编码、丢帧/积压、反馈、缩放等全链路，不能仅以是否WebRTC定优劣。
4. **不承诺无损免费。** Kasm官方明确QOI真无损模式面向LAN、可能大量消耗带宽与CPU，不能拿来直接许诺外网手机也无损低延迟。
5. **不把Windows窗口当作标签。** 微软`CreateForWindow(HWND)`保证的目标是窗口，不是任意后台浏览器tab。Chrome tabCapture则要求用户调用扩展/activeTab授权。成熟项目名本身不能绕开这两个边界。

## 推荐后续验证顺序（尚未实施）

1. 不再给主界面新增技术通道。保留现有会话/鉴权/暂停/设备归属控制层，先把显示模块的验证与产品接入分开。
2. 先做两类独立对照，不接日常Ego：页面级Browserless/Steel路径作功能对照，KasmVNC/Selkies作文字质量机制对照。商业评估、安装、部署和另起图形环境均需事先明确授权；当前没有执行。
3. 必须用同一份12/14px中英文、彩色代码、选区、快速滚动和表单，报告源/接收像素、DPR、停下后清晰恢复时间、点击到对应像素延迟、带宽及CPU，而不是只看30/60fps。
4. 独立对照能胜出现有实现后，再验证是否可用于Windows已有Ego：精确target、多页/重连、无焦点、原登录态、人工暂停保持；任何依赖改用Linux浏览器或窗口移动/激活的前提必须显式说明。
5. 若保持所有现有约束确实找不到现成可用组件，再提供证据化取舍，而不是继续堆第三、第四种产品通道，也不在调研阶段推翻已经完成的控制层。

## 本轮未做

- 未修改产品代码、配置、服务版本或浏览器实例；未点「确认恢复」和「交还Agent」。
- 未执行候选项目、未开远程桌面、未抢焦点、未安装扩展或软件。
- 未作跨产品性能实测；不将宣传中的低延迟/60fps作为本环境承诺。
- 未证明任何候选可无改动连接现有Ego，也未把复用Cookie等价为复用同一实际页面。

## 官方来源

- [S1 Browserless Hybrid Automation：LiveURL、格式、target及WSS](https://docs.browserless.io/baas/monitor-sessions/hybrid-automation)；[自托管版本边界](https://www.browserless.io/platform/self-hosted)。
- [S2 Browserbase Session live view：多页、嵌入及手机键盘边界](https://docs.browserbase.com/platform/browser/observability/session-live-view)。
- [S3 Steel Browser 官方仓库](https://github.com/steel-dev/steel-browser)；[实时viewer界面源码](https://github.com/steel-dev/steel-browser/blob/main/ui/src/components/stage.tsx)；[CDP服务源码](https://github.com/steel-dev/steel-browser/blob/main/api/src/services/cdp/cdp.service.ts)；[自定义Chrome路径](https://github.com/steel-dev/steel-browser/blob/main/api/src/utils/browser.ts)。
- [S4 n.eko 官方仓库](https://github.com/m1k1o/neko)；[v3.2.0发行记录](https://github.com/m1k1o/neko/releases/tag/v3.2.0)；[固定标签README](https://github.com/m1k1o/neko/blob/v3.2.0/README.md)。
- [S5 Selkies 官方仓库](https://github.com/selkies-project/selkies)；[2.2.1发行记录](https://github.com/selkies-project/selkies/releases/tag/2.2.1)；[固定标签参数源码](https://github.com/selkies-project/selkies/blob/2.2.1/src/selkies/settings.py)；[当前设置说明](https://docs.selkies.io/settings)。
- [S6 KasmVNC 1.5.2配置：区域更新、静止无损刷新及UDP transit](https://docs.kasmvnc.com/docs/configuration)；[KasmVNC官方仓库与Linux定位](https://github.com/kasmtech/KasmVNC)；[Kasm真无损模式代价](https://docs.kasm.com/docs/how-to/workspaces-sessions/container-workspace/lossless)。
- [S7 noVNC官方说明、集成及编码支持](https://github.com/novnc/noVNC)。
- [S8 Apache Guacamole官方架构](https://guacamole.apache.org/doc/gug/guacamole-architecture.html)。
- [S9 MeshCentral官方指南](https://docs.meshcentral.com/meshcentral/)。其部分设置说明保留历史文字，本报告不据此宣称当前默认WebRTC状态。
- [S10 BrowserBox当前官方仓库与许可/源码可用性声明](https://github.com/BrowserBox/BrowserBox)。
- [S11 Windows CreateForWindow官方API定义](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow)；[Chrome tabCapture官方授权及targetTabId限制](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)。

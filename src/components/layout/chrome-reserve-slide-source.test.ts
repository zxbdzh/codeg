import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

// Source-level guards for the top strips' corner reserves (ChromeReserve):
// what they slide with lives in CSS and in where the strips mount them, so the
// invariants are asserted on the source, as conversation-detail-panel-layout
// does for the rest of this layout.
const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8")
const flatCss = read("src/app/globals.css")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\s+/g, " ")
const layout = read("src/app/workspace/layout.tsx")
const panel = read("src/components/conversations/conversation-detail-panel.tsx")

const RESERVE_SELECTOR =
  '.panel-slide-animating[data-panel-group-direction="horizontal"] .chrome-reserve'

describe("corner reserve slide", () => {
  // Three copies of one timing: the JS hold on the class, the panels' own
  // transition, and the reserves'. Tabs only change width monotonically while
  // the reserve and its column move on the same curve.
  it("slides the reserves on the side panels' own duration and easing", () => {
    const panelRule = flatCss.match(
      /\.panel-slide-animating > \[data-panel\] \{ transition: flex-grow (\d+)ms ([\w-]+), flex-basis (\d+)ms ([\w-]+); \}/
    )
    const reserveRule = flatCss.match(
      /\.panel-slide-animating\[data-panel-group-direction="horizontal"\] \.chrome-reserve \{ transition: width (\d+)ms ([\w-]+); \}/
    )
    const panelSlideMs = layout.match(/const PANEL_SLIDE_MS = (\d+)/)
    expect(panelRule).not.toBeNull()
    expect(reserveRule).not.toBeNull()
    expect(panelSlideMs).not.toBeNull()
    const [, growMs, growEase, basisMs, basisEase] = panelRule!
    expect(growMs).toBe(basisMs)
    expect(growEase).toBe(basisEase)
    expect(reserveRule![1]).toBe(basisMs)
    expect(reserveRule![2]).toBe(basisEase)
    expect(panelSlideMs![1]).toBe(basisMs)
  })

  // The nested vertical (terminal) group carries the same class while the
  // terminal slides, and no reserve follows the terminal.
  it("arms the reserve transition only from the horizontal shell group", () => {
    expect(flatCss).not.toContain(".panel-slide-animating .chrome-reserve")
  })

  // The opt-out has to repeat the full selector: a shorter one loses on
  // specificity and the reserves would keep sliding under reduced motion.
  it("snaps the reserves under reduced motion", () => {
    const reduced = flatCss.match(
      /@media \(prefers-reduced-motion: reduce\) \{ \.panel-slide-animating > \[data-panel\], ([^{]*) \{ transition: none; \} \}/
    )
    expect(reduced).not.toBeNull()
    expect(reduced![1]).toBe(RESERVE_SELECTOR)
  })

  it("routes every corner reserve in the workspace layout through ChromeReserve", () => {
    expect(layout).not.toMatch(/style=\{\{ width: (left|right)Reserve \}\}/)
    // The workbench-route band reserves the left corner too, and draws its
    // own bottom border — so no strip hairline on its reserve.
    expect(layout).toContain(
      "<ChromeReserve width={leftCornerWidth} line={false} />"
    )
  })

  // Width follows the side panel over the corner (that change slides); which
  // column holds the corner follows the workspace mode / which column is
  // maximized (that change snaps the layout), so it decides whether the
  // reserve is mounted — a reserve still animating after its column had moved
  // left a closing gap.
  it("mounts each reserve by corner ownership and sizes it by the side panel", () => {
    expect(layout).toContain(
      "const leftCornerWidth = sidebarOpen ? 0 : leftReserve"
    )
    expect(layout).toContain(
      "const rightCornerWidth = auxOpen ? 0 : rightReserve"
    )
    // The conversation column is the window's right edge with no file column
    // and while it is maximized over one.
    expect(layout).toContain(
      'const conversationFillsArea = mode === "conversation" || conversationMaximized'
    )
    expect(layout).toContain("const convHoldsRight = conversationFillsArea")
    expect(layout).toContain('const fileHoldsRight = mode === "fusion"')
    expect(layout).toContain("const fileHoldsLeft = filesMaximized")

    // Every conditionally mounted reserve, whatever its guard looks like — so a
    // reserve mounted on sidebar/aux state again shows up here.
    const guarded = [
      ...layout.matchAll(
        /\{([^{}]+?) &&\s*\(?\s*<ChromeReserve\b[^>]*?width=\{(\w+)\}/g
      ),
    ].map((m) => [m[1].trim(), m[2]])
    expect(guarded).toEqual([
      ["convHoldsRight", "rightCornerWidth"],
      ["fileHoldsLeft", "leftCornerWidth"],
      ["fileHoldsRight", "rightCornerWidth"],
    ])
    // The conversation column holds the left corner in both modes: its row
    // opens with an unconditional left reserve.
    expect(layout).toMatch(
      /\{!isConvSplit && \(\s*<div className="flex h-10 [^"]*">\s*<ChromeReserve width=\{leftCornerWidth\} \/>/
    )
  })

  it("mounts a split strip's right reserve only while the column holds the right edge", () => {
    const start = panel.indexOf("function SplitStripCornerReserve(")
    expect(start).toBeGreaterThan(-1)
    const body = panel.slice(start, panel.indexOf("\n}\n", start))
    expect(body).toContain(
      "const { mode, conversationMaximized } = useWorkspaceView()"
    )
    expect(body).not.toContain("if (focusedTabId !== null) return null")
    expect(body).toContain(
      'const holdsRight = mode === "conversation" || conversationMaximized'
    )
    expect(body).toContain('if (side === "right" && !holdsRight) return null')
    expect(body).not.toContain("width <= 0")
    expect(body).toMatch(/:\s*auxOpen\s*\?\s*0\s*:\s*rightChromeReserve\(/)
    expect(body).toContain("return <ChromeReserve width={width} />")
  })

  // 文件标签原地聚焦要像文件列最大化一样覆盖整个工作区；只隐藏会话列会
  // 留下左侧空白，视觉上像一列窄文件编辑器飘在右边。
  it("covers the workspace when a file tab is focused", () => {
    expect(layout).toMatch(
      /fileFocused &&\s*"absolute inset-0 z-30 w-full bg-background ws-transparent-bg/
    )
    expect(layout).toContain(
      'filesMaximized || fileFocused ? "absolute" : "relative"'
    )
  })

  // 单标签聚焦只改变中间内容列；左右侧栏、辅助面板、状态栏和窗口 chrome
  // 继续保留，用户可以在聚焦会话时切换项目或打开旁问。
  it("keeps the surrounding workspace chrome visible while focused", () => {
    expect(layout).toContain("const focusActive = focusedTabId !== null")
    expect(layout).toContain("const sidebarOpen = baseSidebarOpen")
    expect(layout).toContain("const auxOpen = auxOpenRequested")
    expect(layout).toContain("const terminalOpen = terminalOpenRequested")
    expect(layout).toContain("<StatusBar />")
    expect(layout).toContain("{!isMobile && (")
    expect(layout).not.toContain("FocusHideSurface")
    expect(layout).toMatch(
      /const leftReserve = leftChromeReserve\(/
    )
    expect(layout).toMatch(
      /const rightReserve = rightChromeReserve\(/
    )
  })

  // 顶层灵动岛只占顶部 40px，并始终按窗口 chrome 的较大预留居中；否则
  // 本地拖动版会把安全区放大到整窗，胶囊可压住右上角的终端/设置按钮。
  it("keeps the desktop pane switcher inside the top chrome safe area", () => {
    expect(layout).toContain(
      "const paneSwitcherInset = Math.max(\n    leftChromeReserve(isMac && isDesktop(), zoomLevel),\n    rightChromeReserve(winLinuxControls, zoomLevel)\n  )"
    )
    expect(layout).toContain(
      'className="pointer-events-none absolute top-0 z-40 h-10"'
    )
  })

  // 只把内容 section 设成 absolute 时，ResizablePanelGroup 仍保留 56/44 的
  // 列宽；标签条和退出按钮会停在旧列右缘。聚焦期间要同步把面板组改为
  // 100/0 或 0/100，退出后用原 fusion 比例恢复。
  it("fills the panel group while a tab is focused", () => {
    expect(layout).toContain(
      'const conversationFocused = focusedTabPane === "conversation"'
    )
    expect(layout).toContain('const fileFocused = focusedTabPane === "files"')
    expect(layout).toContain("conversationFillsArea || conversationFocused")
    expect(layout).toContain("filesMaximized || fileFocused")
  })

  // 外层 shell 用固定 px 锁定侧栏/辅助面板宽度；聚焦时只重排中间内容，
  // 不能把两侧面板压成 0，否则用户会失去导航和旁问入口。
  it("keeps outer shell side panels while focused", () => {
    expect(layout).toContain("const requestedLeft = sidebarOpen")
    expect(layout).toContain("const requestedRight = auxOpen")
    expect(layout).not.toContain(
      "return { left: 0, right: 0, totalWidth: shellPanelsWidth }"
    )
  })
})

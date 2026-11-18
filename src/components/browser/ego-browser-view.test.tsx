import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { EgoSession } from "@/lib/browser/ego-api"

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  video: vi.fn(),
  rtc: vi.fn(),
}))
vi.mock("@/lib/browser/ego-rtc-stream", () => ({ watchEgoRtc: mocks.rtc }))
vi.mock("@/lib/browser/ego-video-stream", () => ({
  watchEgoVideo: mocks.video,
  egoVideoUnavailableReason: () => "当前设备不支持此视频通道",
}))
vi.mock("@/lib/browser/ego-api", async (original) => ({
  ...(await original<typeof import("@/lib/browser/ego-api")>()),
  egoRequest: mocks.request,
}))
vi.mock("@/lib/api", () => ({ uploadAttachment: vi.fn() }))
vi.mock("@/lib/browser/ego-frame-stream", () => ({
  watchEgoFrames: () => null,
}))

import { EgoBrowserGateway, EgoBrowserView } from "./ego-browser-view"
import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"

describe("Ego 执行端配置同步", () => {
  it("已挂载面板跟随其他面板或设备的配置变化", async () => {
    let enabled = false
    mocks.request.mockImplementation(async () => ({
      config: { enabled, endpoint: "http://127.0.0.1:9222", serverName: "" },
    }))
    render(
      <EgoBrowserGateway tab={{ browser: {} } as BrowserWorkspaceTab}>
        <p>原来的浏览器</p>
      </EgoBrowserGateway>
    )
    await screen.findByText("原来的浏览器")
    enabled = true
    await act(async () => {
      window.dispatchEvent(new Event("codeg:ego-config-changed"))
    })
    expect(screen.queryByText("原来的浏览器")).not.toBeInTheDocument()
    expect(screen.getByText("Ego · 执行端真实页面")).toBeVisible()
    enabled = false
    await screen.findByText("原来的浏览器", {}, { timeout: 3000 })
  })
})

describe("Ego 查看挂起", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800)
    mocks.video.mockReset()
    mocks.video.mockReturnValue(null)
    mocks.rtc.mockReset()
    mocks.rtc.mockReturnValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function gateway(id: string) {
    return (
      <EgoBrowserGateway
        tab={
          {
            id,
            browser: {
              conversationId: 7,
              initialUrl: "https://example.com/one",
            },
          } as BrowserWorkspaceTab
        }
      >
        <p>原来的浏览器</p>
      </EgoBrowserGateway>
    )
  }

  it("连接中也能挂起，停止轮询并阻止迟到的连接创建页面", async () => {
    let finishConnection: (session: EgoSession) => void = () => {}
    const connecting = new Promise<EgoSession>((resolve) => {
      finishConnection = resolve
    })
    mocks.request.mockReset()
    mocks.request.mockImplementation(async (request) => {
      if (request.method === "config")
        return {
          config: {
            enabled: true,
            endpoint: "http://127.0.0.1:54146",
            serverName: "codeg-daily",
          },
        }
      if (request.method === "session") return connecting
      return initialSession()
    })

    render(gateway("suspend-connecting"))
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith({
        method: "session",
        sessionId: 7,
      })
    )
    fireEvent.click(await screen.findByRole("button", { name: "挂起 Ego" }))
    expect(screen.getByText("Ego 已挂起")).toBeVisible()
    const requestCount = mocks.request.mock.calls.length
    await act(async () => finishConnection(initialSession()))
    vi.useFakeTimers()
    await act(async () => vi.advanceTimersByTime(3500))
    expect(mocks.request).toHaveBeenCalledTimes(requestCount)
  })

  it("挂起状态在切回标签后保留，继续使用复用原页面", async () => {
    mocks.request.mockReset()
    mocks.request.mockImplementation(async (request) => {
      if (request.method === "config")
        return {
          config: {
            enabled: true,
            endpoint: "http://127.0.0.1:54146",
            serverName: "codeg-daily",
          },
        }
      if (request.method === "frame")
        return {
          data: "",
          width: 800,
          height: 600,
          chooser: null,
          dialog: null,
        }
      return initialSession()
    })
    const first = render(gateway("suspend-remount"))
    await screen.findByAltText("Ego 执行端真实页面")
    fireEvent.click(screen.getByRole("button", { name: "挂起 Ego" }))
    first.unmount()
    mocks.request.mockClear()

    render(gateway("suspend-remount"))
    expect(screen.getByText("Ego 已挂起")).toBeVisible()
    expect(mocks.request).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "继续使用 Ego" }))
    await screen.findByAltText("Ego 执行端真实页面")
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "visit",
        sessionId: 7,
        viewId: "suspend-remount",
        url: "https://example.com/one",
      })
    )
    expect(
      mocks.request.mock.calls.some(
        ([request]) =>
          request.method === "closeView" ||
          request.method === "return" ||
          (request.method === "human" && request.action.kind === "close")
      )
    ).toBe(false)
  })
})

function initialSession(): EgoSession {
  return {
    sessionId: 7,
    revision: 1,
    spaceId: 21,
    tabs: [
      {
        id: "page-one",
        url: "https://example.com/one",
        title: "第一页",
        live: true,
      },
      {
        id: "page-two",
        url: "https://example.com/two",
        title: "第二页",
        live: true,
      },
    ],
    downloads: [],
    control: { owner: null, epoch: 1, recoveryRequired: false },
    connected: true,
    blocked: null,
    evalRequest: null,
  }
}

describe("Ego 会话页面与控制权", () => {
  let current: EgoSession
  beforeEach(() => {
    localStorage.setItem("ego:device-id", "device-current")
    current = initialSession()
    mocks.request.mockReset()
    mocks.video.mockReset()
    mocks.video.mockReturnValue(null)
    mocks.rtc.mockReset()
    mocks.rtc.mockReturnValue(null)
    mocks.request.mockImplementation(
      async (request: Record<string, unknown>) => {
        if (request.method === "frame")
          return {
            data: "",
            width: 800,
            height: 600,
            chooser: null,
            dialog: null,
          }
        if (request.method === "human") {
          const action = request.action as {
            kind: string
            mode?: "mobile" | "desktop"
            width?: number
            height?: number
          }
          if (action.kind === "viewport") {
            current.tabs = current.tabs.map((tab) =>
              tab.id === request.tabId
                ? {
                    ...tab,
                    viewport: {
                      mode: action.mode!,
                      width: action.width!,
                      height: action.height!,
                    },
                  }
                : tab
            )
            return structuredClone(current)
          }
          current = {
            ...current,
            revision: current.revision + 1,
            control: {
              ...current.control,
              owner: "device-current",
              epoch:
                current.control.epoch +
                Number(current.control.owner !== "device-current"),
            },
            tabs:
              action.kind === "close"
                ? current.tabs.filter((tab) => tab.id !== request.tabId)
                : current.tabs,
          }
        }
        if (request.method === "return")
          current = {
            ...current,
            revision: current.revision + 1,
            control: {
              ...current.control,
              owner: null,
              epoch: current.control.epoch + 1,
            },
          }
        return structuredClone(current)
      }
    )
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function view() {
    return render(
      <EgoBrowserView
        sessionId={7}
        viewId="view-seven"
        initialUrl="https://example.com/one"
      />
    )
  }

  async function touchView() {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800)
    const mounted = view()
    const image = await screen.findByAltText("Ego 执行端真实页面")
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    const touch = (type: string, x = 40, y = 60) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: x,
        clientY: y,
      })
      Object.defineProperties(event, {
        pointerId: { value: 11 },
        pointerType: { value: "touch" },
      })
      fireEvent(image, event)
    }
    return { mounted, touch }
  }

  function mobileDevice() {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: () => true,
    }))
  }

  it("手机已接管时默认移动页面，全屏切桌面横向，退出恢复移动页面", async () => {
    mobileDevice()
    vi.stubGlobal("innerWidth", 390)
    vi.stubGlobal("innerHeight", 844)
    current.control.owner = "device-current"
    view()
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "human",
          action: {
            kind: "viewport",
            mode: "mobile",
            width: 390,
            height: 546,
          },
        })
      )
    )
    fireEvent.click(screen.getByRole("button", { name: "全屏显示 Ego" }))
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        expect.objectContaining({
          action: {
            kind: "viewport",
            mode: "desktop",
            width: 1280,
            height: 318,
          },
        })
      )
    )
    expect(document.querySelector('[data-ego-rotated="true"]')).toHaveStyle({
      width: "844px",
      height: "390px",
    })
    fireEvent.click(screen.getByRole("button", { name: "退出 Ego 全屏" }))
    await waitFor(() =>
      expect(
        mocks.request.mock.calls.filter(
          ([request]) =>
            request.action?.kind === "viewport" &&
            request.action?.mode === "mobile"
        )
      ).toHaveLength(2)
    )
    expect(current.control.owner).toBe("device-current")
    expect(current.control.epoch).toBe(1)
  })

  it("手机只观看或其他设备接管时，不发送尺寸变化或自动暂停 Agent", async () => {
    mobileDevice()
    const mounted = view()
    await screen.findByRole("tab", { name: "第一页" })
    fireEvent.click(screen.getByRole("button", { name: "全屏显示 Ego" }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
    })
    expect(
      mocks.request.mock.calls.some(([request]) => request.method === "human")
    ).toBe(false)
    mounted.unmount()
    current.control.owner = "other-device"
    view()
    await screen.findByRole("button", { name: "接管到此设备" })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
    })
    expect(
      mocks.request.mock.calls.some(([request]) => request.method === "human")
    ).toBe(false)
  })

  it("手机短按页面不弹键盘，显式输入按钮才聚焦并提供辅助按键", async () => {
    mobileDevice()
    const { touch } = await touchView()
    const keyboard = screen.getByRole("textbox", { name: "向 Ego 页面输入" })
    const focus = vi.spyOn(keyboard, "focus")
    expect(keyboard).toHaveAttribute("inputmode", "none")
    touch("pointerdown")
    touch("pointerup")
    expect(focus).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(
        mocks.request.mock.calls.filter(
          ([request]) => request.action?.kind === "pointer"
        )
      ).toHaveLength(2)
    )
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "打开 Ego 输入键盘" })
      ).toBeEnabled()
    )
    fireEvent.click(screen.getByRole("button", { name: "打开 Ego 输入键盘" }))
    expect(keyboard).toHaveFocus()
    expect(keyboard).toHaveAttribute("inputmode", "text")
    fireEvent.change(keyboard, { target: { value: "手机中文" } })
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        expect.objectContaining({
          tabId: "page-one",
          action: { kind: "text", text: "手机中文" },
        })
      )
    )
    fireEvent.click(screen.getByRole("button", { name: "回车" }))
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.objectContaining({
            kind: "key",
            type: "keyUp",
            key: "Enter",
          }),
        })
      )
    )
    fireEvent.click(screen.getByRole("button", { name: "收起 Ego 输入键盘" }))
    expect(keyboard).toHaveAttribute("inputmode", "none")
    expect(screen.queryByLabelText("Ego 输入辅助按键")).not.toBeInTheDocument()
  })

  it("手机查看缩放和平移不接管，放大后的滑动不发送远端滚轮", async () => {
    mobileDevice()
    const { touch } = await touchView()
    fireEvent.click(screen.getByRole("button", { name: "显示设置" }))
    fireEvent.click(screen.getByRole("button", { name: "200%" }))
    expect(screen.getByRole("button", { name: "200%" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    expect(screen.getByLabelText("Ego 页面画面区域")).toHaveClass(
      "overflow-auto"
    )
    touch("pointerdown")
    touch("pointermove", 40, 110)
    touch("pointerup", 40, 110)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80))
    })
    expect(
      mocks.request.mock.calls.some(([request]) => request.method === "human")
    ).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "适应" }))
    expect(screen.getByLabelText("Ego 页面画面区域")).toHaveClass(
      "overflow-hidden"
    )
  })

  it("手机切页关闭输入，地址字段禁用自动纠正且只读端不能开启键盘", async () => {
    mobileDevice()
    await touchView()
    const address = screen.getByRole("textbox", { name: "Ego 页面地址" })
    expect(address).toHaveAttribute("inputmode", "url")
    expect(address).toHaveAttribute("autocapitalize", "none")
    fireEvent.click(screen.getByRole("button", { name: "打开 Ego 输入键盘" }))
    fireEvent.click(screen.getByRole("tab", { name: "第二页" }))
    expect(
      screen.getByRole("textbox", { name: "向 Ego 页面输入" })
    ).toHaveAttribute("inputmode", "none")
    current = {
      ...current,
      revision: current.revision + 1,
      control: {
        ...current.control,
        owner: "other-device",
        epoch: current.control.epoch + 1,
      },
    }
    await waitFor(
      () =>
        expect(
          screen.getByRole("button", { name: "打开 Ego 输入键盘" })
        ).toBeDisabled(),
      { timeout: 2000 }
    )
  })

  it("手机网页内全屏跟随软键盘可见高度，退出后恢复原布局且不接管", async () => {
    mobileDevice()
    const viewport = Object.assign(new EventTarget(), {
      width: 390,
      height: 844,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
    })
    vi.stubGlobal("visualViewport", viewport)
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    view()
    await screen.findByRole("tab", { name: "第一页" })
    fireEvent.click(screen.getByRole("button", { name: "全屏显示 Ego" }))
    const region = screen.getByRole("region", { name: "Ego 浏览器" })
    expect(region).toHaveStyle({ height: "844px", top: "0px" })
    act(() => {
      viewport.height = 420
      viewport.offsetTop = 12
      viewport.dispatchEvent(new Event("resize"))
    })
    expect(region).toHaveStyle({ height: "420px", top: "12px" })
    fireEvent.click(screen.getByRole("button", { name: "退出 Ego 全屏" }))
    expect(
      screen.getByRole("region", { name: "Ego 浏览器" }).style.height
    ).toBe("")
    expect(
      mocks.request.mock.calls.some(([request]) =>
        ["human", "return", "restore"].includes(request.method)
      )
    ).toBe(false)
  })

  it("WebRTC 输入结果不确认时不改用 HTTP 重发，观看和卸载不交还 Agent", async () => {
    const cancel = vi.fn()
    const send = vi.fn().mockRejectedValue(new Error("实时输入结果未确认"))
    mocks.rtc.mockReturnValue({ cancel, send })
    const mounted = view()
    await screen.findByRole("tab", { name: "第一页" })
    fireEvent.click(screen.getByRole("button", { name: "显示设置" }))
    fireEvent.click(screen.getByRole("button", { name: "实时（推荐）" }))
    await waitFor(() => expect(mocks.rtc).toHaveBeenCalledOnce())
    expect(
      mocks.request.mock.calls.some(([request]) => request.method === "human")
    ).toBe(false)
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "向 Ego 页面输入" }),
      { key: "a" }
    )
    await screen.findByText("实时输入结果未确认")
    expect(send).toHaveBeenCalledWith(1, { kind: "text", text: "a" })
    expect(
      mocks.request.mock.calls.some(([request]) => request.method === "human")
    ).toBe(false)
    mounted.unmount()
    expect(cancel).toHaveBeenCalledOnce()
    expect(
      mocks.request.mock.calls.some(([request]) => request.method === "return")
    ).toBe(false)
  })

  it("默认不并排展示技术通道，显示设置内保留兼容回退且不接管页面", async () => {
    view()
    await screen.findByRole("tab", { name: "第一页" })
    expect(screen.getByRole("button", { name: "显示设置" })).toHaveAttribute(
      "aria-expanded",
      "false"
    )
    expect(
      screen.queryByRole("button", { name: "WebRTC" })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "启用视频" })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "兼容画面" })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "显示设置" }))
    fireEvent.click(screen.getByRole("button", { name: "兼容画面" }))
    expect(screen.getByRole("button", { name: "兼容画面" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    expect(
      mocks.request.mock.calls.some(([request]) =>
        ["human", "return", "restore"].includes(request.method)
      )
    ).toBe(false)
  })

  it("实时模式已经播放时再次选择它不清空画面或重建连接", async () => {
    vi.stubGlobal("RTCPeerConnection", class {})
    mocks.rtc.mockImplementation(() => ({ cancel: vi.fn(), send: vi.fn() }))
    view()
    await waitFor(() => expect(mocks.rtc).toHaveBeenCalledOnce())
    act(() => mocks.rtc.mock.calls[0][5]())
    expect(screen.getByText("实时画面")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "显示设置" }))
    fireEvent.click(screen.getByRole("button", { name: "实时（推荐）" }))
    expect(screen.getByText("实时画面")).toBeInTheDocument()
    expect(mocks.rtc).toHaveBeenCalledOnce()
  })

  it("手机全屏切换及真实视口更新保留媒体节点与连接，不重复协商", async () => {
    mobileDevice()
    vi.stubGlobal("innerWidth", 390)
    vi.stubGlobal("innerHeight", 844)
    vi.stubGlobal("RTCPeerConnection", class {})
    current.control.owner = "device-current"
    const cancel = vi.fn()
    mocks.rtc.mockReturnValue({ cancel, send: vi.fn() })
    const mounted = view()
    await waitFor(() => expect(current.tabs[0].viewport?.mode).toBe("mobile"))
    await waitFor(() => expect(mocks.rtc).toHaveBeenCalled())
    const originalVideo = document.querySelector("video")
    const originalCalls = mocks.rtc.mock.calls.length
    act(() => {
      mocks.rtc.mock.calls[originalCalls - 1][5]()
      mocks.rtc.mock.calls[originalCalls - 1][7]({
        data: "",
        width: 390,
        height: 546,
        chooser: null,
        dialog: null,
      })
    })
    fireEvent.click(screen.getByRole("button", { name: "全屏显示 Ego" }))
    await waitFor(() => expect(current.tabs[0].viewport?.mode).toBe("desktop"))
    await waitFor(() => expect(originalVideo).toHaveAttribute("width", "1280"))
    expect(originalVideo).toHaveAttribute("height", "318")
    expect(document.querySelector("video")).toBe(originalVideo)
    expect(mocks.rtc).toHaveBeenCalledTimes(originalCalls)
    expect(cancel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "退出 Ego 全屏" }))
    await waitFor(() => expect(current.tabs[0].viewport?.mode).toBe("mobile"))
    expect(document.querySelector("video")).toBe(originalVideo)
    expect(mocks.rtc).toHaveBeenCalledTimes(originalCalls)
    mounted.unmount()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("手机长按选词后显示复制入口，松手不误发左键点击，也不弹输入键盘", async () => {
    const implementation = mocks.request.getMockImplementation()!
    mocks.request.mockImplementation(
      async (request: Record<string, unknown>) => {
        const next = await implementation(request)
        return (request.action as { kind?: string })?.kind === "selectWord"
          ? {
              ...next,
              contextMenu: {
                handled: false,
                linkUrl: null,
                selection: "浏览器",
                editable: false,
              },
            }
          : next
      }
    )
    const { touch } = await touchView()
    const keyboard = screen.getByRole("textbox", { name: "向 Ego 页面输入" })
    const focus = vi.spyOn(keyboard, "focus")
    touch("pointerdown")
    await screen.findByRole("menuitem", { name: "复制所选文字" })
    touch("pointerup")
    expect(
      mocks.request.mock.calls.filter(
        ([request]) => request.action?.kind === "selectWord"
      )
    ).toHaveLength(1)
    expect(
      mocks.request.mock.calls.some(
        ([request]) => request.action?.kind === "pointer"
      )
    ).toBe(false)
    expect(focus).not.toHaveBeenCalled()
  })

  it("手机滑动取消长按且保留滚动，取消或切页后不发送旧选词", async () => {
    const { touch } = await touchView()
    touch("pointerdown")
    touch("pointermove", 40, 90)
    touch("pointerup", 40, 90)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
    })
    expect(
      mocks.request.mock.calls.some(
        ([request]) => request.action?.kind === "selectWord"
      )
    ).toBe(false)
    expect(
      mocks.request.mock.calls.some(
        ([request]) => request.action?.type === "mouseWheel"
      )
    ).toBe(true)
    touch("pointerdown")
    fireEvent.click(screen.getByRole("tab", { name: "第二页" }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
    })
    expect(
      mocks.request.mock.calls.some(
        ([request]) => request.action?.kind === "selectWord"
      )
    ).toBe(false)
  })

  it("手机短按仍点击，长按请求在切页后迟到不会打开旧菜单", async () => {
    const implementation = mocks.request.getMockImplementation()!
    let finish: (session: EgoSession) => void = () => {}
    let response: EgoSession | null = null
    mocks.request.mockImplementation(
      async (request: Record<string, unknown>) => {
        const next = await implementation(request)
        if ((request.action as { kind?: string })?.kind !== "selectWord")
          return next
        response = {
          ...next,
          contextMenu: {
            handled: false,
            linkUrl: null,
            selection: "旧页文字",
            editable: false,
          },
        }
        return new Promise<EgoSession>((resolve) => {
          finish = resolve
        })
      }
    )
    const { touch } = await touchView()
    touch("pointerdown")
    touch("pointerup")
    await waitFor(() =>
      expect(
        mocks.request.mock.calls.filter(
          ([request]) => request.action?.kind === "pointer"
        )
      ).toHaveLength(2)
    )
    touch("pointerdown")
    await waitFor(() => expect(response).not.toBeNull())
    touch("pointerup")
    fireEvent.click(screen.getByRole("tab", { name: "第二页" }))
    await act(async () => finish(response!))
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  })

  it("其他设备只读时手机长按不发送选词", async () => {
    current.control.owner = "other-device"
    const { touch } = await touchView()
    touch("pointerdown")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
    })
    expect(
      mocks.request.mock.calls.some(([request]) => request.method === "human")
    ).toBe(false)
  })

  it.each(["pointercancel", "lostpointercapture"])(
    "手机 %s 后不再触发长按",
    async (type) => {
      const { touch } = await touchView()
      touch("pointerdown")
      touch(type)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 600))
      })
      expect(
        mocks.request.mock.calls.some(
          ([request]) => request.action?.kind === "selectWord"
        )
      ).toBe(false)
    }
  )

  it("复制仅写入访问设备，权限失败时显示可手动复制文字而不虚报成功", async () => {
    const implementation = mocks.request.getMockImplementation()!
    mocks.request.mockImplementation(
      async (request: Record<string, unknown>) => {
        const next = await implementation(request)
        return (request.action as { kind?: string })?.kind === "selectWord"
          ? {
              ...next,
              contextMenu: {
                handled: false,
                linkUrl: null,
                selection: "浏览器",
                editable: false,
              },
            }
          : next
      }
    )
    const writeText = vi.fn().mockRejectedValue(new Error("denied"))
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    const exec = vi.fn().mockReturnValue(false)
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: exec,
    })
    const { touch } = await touchView()
    touch("pointerdown")
    const copy = await screen.findByRole("menuitem", { name: "复制所选文字" })
    touch("pointerup")
    fireEvent.click(copy)
    expect(
      await screen.findByRole("textbox", { name: "手动复制文字" })
    ).toHaveValue("浏览器")
    expect(screen.queryByText("已复制到当前设备")).not.toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith("浏览器")
    exec.mockReturnValue(true)
    fireEvent.click(copy)
    await screen.findByText("已复制到当前设备")
    expect(exec).toHaveBeenCalledWith("copy")
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    Reflect.deleteProperty(document, "execCommand")
  })

  it("首次从局域网 HTTP 打开面板不因缺少安全上下文 UUID 而崩溃", async () => {
    localStorage.removeItem("ego:device-id")
    const original = globalThis.crypto
    vi.stubGlobal("crypto", {
      getRandomValues: original.getRandomValues.bind(original),
    })
    view()
    expect(await screen.findByRole("tab", { name: "第一页" })).toBeVisible()
    expect(localStorage.getItem("ego:device-id")).toHaveLength(36)
    expect(
      mocks.request.mock.calls.some(([request]) => request.method === "human")
    ).toBe(false)
  })

  it("视频不支持时回退原通道，不接管或交还页面", async () => {
    view()
    await screen.findByRole("tab", { name: "第一页" })
    fireEvent.click(screen.getByRole("button", { name: "显示设置" }))
    fireEvent.click(screen.getByText("高级排障"))
    fireEvent.click(screen.getByRole("button", { name: "兼容视频（仅排障）" }))
    expect(await screen.findByRole("status")).toHaveTextContent(
      "继续使用原画面"
    )
    expect(mocks.video).toHaveBeenCalled()
    expect(
      mocks.request.mock.calls.some(([request]) =>
        ["human", "return"].includes(request.method)
      )
    ).toBe(false)
  })

  it("视频切页取消旧连接，旧回调不会覆盖新页或触发回退", async () => {
    const cancel = vi.fn()
    mocks.video.mockReturnValue(cancel)
    const mounted = view()
    await screen.findByRole("tab", { name: "第一页" })
    fireEvent.click(screen.getByRole("button", { name: "显示设置" }))
    fireEvent.click(screen.getByText("高级排障"))
    fireEvent.click(screen.getByRole("button", { name: "兼容视频（仅排障）" }))
    await waitFor(() => expect(mocks.video).toHaveBeenCalledOnce())
    const previous = mocks.video.mock.calls[0]
    fireEvent.click(screen.getByRole("tab", { name: "第二页" }))
    await waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    act(() => {
      previous[3]()
      previous[4]()
    })
    expect(
      screen.getByRole("button", { name: "兼容视频（仅排障）" })
    ).toHaveAttribute("aria-pressed", "true")
    mounted.unmount()
    expect(cancel).toHaveBeenCalledTimes(2)
  })

  it("观看与卸载不会接管或交还，关闭只指定一页并保留交还入口", async () => {
    const mounted = view()
    await screen.findByRole("tab", { name: "第一页" })
    expect(
      mocks.request.mock.calls.some(([request]) => request.method === "human")
    ).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "关闭 第一页" }))
    await screen.findByRole("button", { name: "交还 Agent" })
    expect(
      screen.queryByRole("tab", { name: "第一页" })
    ).not.toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "第二页" })).toBeInTheDocument()
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "human",
        sessionId: 7,
        tabId: "page-one",
        action: { kind: "close" },
      })
    )
    mounted.unmount()
    expect(
      mocks.request.mock.calls.some(([request]) => request.method === "return")
    ).toBe(false)
  })

  it("左键按住拖动使用 buttons 保留左键，不把 pointermove 的 button=-1 当悬停", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800)
    view()
    const image = await screen.findByAltText("Ego 执行端真实页面")
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    const pointer = (
      type: string,
      button: number,
      buttons: number,
      x: number
    ) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button,
        buttons,
        clientX: x,
        clientY: 60,
      })
      Object.defineProperties(event, {
        pointerId: { value: 1 },
        pointerType: { value: "mouse" },
      })
      fireEvent(image, event)
    }
    pointer("pointerdown", 0, 1, 40)
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.objectContaining({ type: "mousePressed" }),
        })
      )
    )
    pointer("pointermove", -1, 1, 200)
    pointer("pointerup", 0, 0, 200)
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        expect.objectContaining({
          tabId: "page-one",
          action: expect.objectContaining({
            type: "mouseMoved",
            button: "left",
            buttons: 1,
          }),
        })
      )
    )
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.objectContaining({
          type: "mouseReleased",
          button: "left",
          buttons: 0,
        }),
      })
    )
  })

  it("右键显示 Web 菜单并只发一次远端右键，链接操作仍绑定原页", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800)
    const implementation = mocks.request.getMockImplementation()!
    mocks.request.mockImplementation(
      async (request: Record<string, unknown>) => {
        const next = await implementation(request)
        if ((request.action as { kind?: string })?.kind === "context")
          return {
            ...next,
            contextMenu: {
              handled: false,
              linkUrl: "https://example.com/link",
              selection: "已选择文字",
              editable: false,
            },
          }
        return next
      }
    )
    view()
    const image = await screen.findByAltText("Ego 执行端真实页面")
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    fireEvent.contextMenu(image, { clientX: 40, clientY: 30, button: 2 })
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "在新标签页打开链接" })
    )
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        expect.objectContaining({
          action: { kind: "open", url: "https://example.com/link" },
        })
      )
    )
    expect(
      mocks.request.mock.calls.filter(
        ([request]) => request.action?.kind === "context"
      )
    ).toHaveLength(1)
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "human",
        tabId: "page-one",
        action: expect.objectContaining({ kind: "context", x: 40, y: 30 }),
      })
    )
  })

  it("网页自行处理右键时不叠加 Web 菜单，只读端不发送右键", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800)
    const implementation = mocks.request.getMockImplementation()!
    mocks.request.mockImplementation(
      async (request: Record<string, unknown>) => {
        const next = await implementation(request)
        return (request.action as { kind?: string })?.kind === "context"
          ? {
              ...next,
              contextMenu: {
                handled: true,
                linkUrl: null,
                selection: "",
                editable: false,
              },
            }
          : next
      }
    )
    const mounted = view()
    const image = await screen.findByAltText("Ego 执行端真实页面")
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    fireEvent.contextMenu(image, { clientX: 40, clientY: 30, button: 2 })
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.objectContaining({ kind: "context" }),
        })
      )
    )
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    mounted.unmount()
    mocks.request.mockClear()
    current.control.owner = "other-device"
    view()
    const readOnlyImage = await screen.findByAltText("Ego 执行端真实页面")
    fireEvent.contextMenu(readOnlyImage, {
      clientX: 40,
      clientY: 30,
      button: 2,
    })
    expect(
      mocks.request.mock.calls.some(([request]) => request.method === "human")
    ).toBe(false)
  })

  it("切页后丢弃迟到的右键结果，不在新页面显示旧菜单", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800)
    const implementation = mocks.request.getMockImplementation()!
    let finish: (session: EgoSession) => void = () => {}
    let response: EgoSession | null = null
    mocks.request.mockImplementation(
      async (request: Record<string, unknown>) => {
        const next = await implementation(request)
        if ((request.action as { kind?: string })?.kind !== "context")
          return next
        response = {
          ...next,
          contextMenu: {
            handled: false,
            linkUrl: "https://example.com/old-page",
            selection: "",
            editable: false,
          },
        }
        return new Promise<EgoSession>((resolve) => {
          finish = resolve
        })
      }
    )
    view()
    const image = await screen.findByAltText("Ego 执行端真实页面")
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    fireEvent.contextMenu(image, { clientX: 40, clientY: 30, button: 2 })
    await waitFor(() => expect(response).not.toBeNull())
    fireEvent.click(screen.getByRole("tab", { name: "第二页" }))
    await act(async () => finish(response!))
    expect(screen.getByRole("tab", { name: "第二页" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  })

  it("全屏仅扩展当前 Web 页面，退出和 Esc 不接管或交还 Agent", async () => {
    view()
    await screen.findByRole("tab", { name: "第一页" })
    fireEvent.click(screen.getByRole("button", { name: "全屏显示 Ego" }))
    expect(screen.getByRole("region", { name: "Ego 浏览器" })).toHaveClass(
      "fixed",
      "inset-0"
    )
    fireEvent.click(screen.getByRole("button", { name: "退出 Ego 全屏" }))
    expect(screen.getByRole("region", { name: "Ego 浏览器" })).not.toHaveClass(
      "fixed"
    )
    fireEvent.click(screen.getByRole("button", { name: "全屏显示 Ego" }))
    fireEvent.keyDown(document, { key: "Escape" })
    fireEvent.keyUp(screen.getByRole("textbox", { name: "向 Ego 页面输入" }), {
      key: "Escape",
    })
    expect(screen.getByRole("button", { name: "全屏显示 Ego" })).toBeVisible()
    expect(
      mocks.request.mock.calls.some(([request]) =>
        ["human", "return"].includes(String(request.method))
      )
    ).toBe(false)
  })

  it("浏览器原生全屏绑定当前显示容器，浏览器退出后按钮状态同步", async () => {
    let nativeElement: Element | null = null
    const originalElement = Object.getOwnPropertyDescriptor(
      document,
      "fullscreenElement"
    )
    const originalRequest = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "requestFullscreen"
    )
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => nativeElement,
    })
    const enter = vi.fn(() => {
      nativeElement = screen.getByRole("region", { name: "Ego 浏览器" })
      document.dispatchEvent(new Event("fullscreenchange"))
      return Promise.resolve()
    })
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: enter,
    })
    try {
      view()
      await screen.findByRole("tab", { name: "第一页" })
      fireEvent.click(screen.getByRole("button", { name: "全屏显示 Ego" }))
      await waitFor(() => expect(enter).toHaveBeenCalledOnce())
      expect(enter.mock.contexts[0]).toBe(nativeElement)
      expect(nativeElement).toBe(
        screen.getByRole("region", { name: "Ego 浏览器" })
      )
      act(() => {
        nativeElement = null
        document.dispatchEvent(new Event("fullscreenchange"))
      })
      expect(screen.getByRole("button", { name: "全屏显示 Ego" })).toBeVisible()
    } finally {
      if (originalElement)
        Object.defineProperty(document, "fullscreenElement", originalElement)
      else Reflect.deleteProperty(document, "fullscreenElement")
      if (originalRequest)
        Object.defineProperty(
          HTMLElement.prototype,
          "requestFullscreen",
          originalRequest
        )
      else Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen")
    }
  })

  it("其他设备占用时只读，只有显式切换才发送转移操作", async () => {
    current.control.owner = "another-device"
    view()
    await screen.findByRole("button", { name: "接管到此设备" })
    expect(screen.getByRole("button", { name: "关闭 第一页" })).toBeDisabled()
    expect(
      screen.queryByRole("button", { name: "交还 Agent" })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "接管到此设备" }))
    await screen.findByRole("button", { name: "交还 Agent" })
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "human", action: { kind: "takeover" } })
    )
  })

  it("恢复前仍可显式转移到新设备，页面输入继续禁用", async () => {
    current.control.owner = "old-device"
    current.control.recoveryRequired = true
    view()
    const takeover = await screen.findByRole("button", { name: "接管到此设备" })
    expect(takeover).toBeEnabled()
    expect(screen.getByRole("button", { name: "关闭 第一页" })).toBeDisabled()
    fireEvent.click(takeover)
    const restore = await screen.findByRole("button", { name: "确认恢复" })
    await waitFor(() => expect(restore).toBeEnabled())
    expect(screen.getByRole("button", { name: "交还 Agent" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "关闭 第一页" })).toBeDisabled()
  })

  it("排队输入保留原目标，切页后不会误投到另一真实页面", async () => {
    let finish: (state: EgoSession) => void = () => {}
    const implementation = mocks.request.getMockImplementation()!
    let first = true
    mocks.request.mockImplementation((request: Record<string, unknown>) => {
      if (request.method === "human" && first) {
        first = false
        return new Promise<EgoSession>((resolve) => {
          finish = resolve
        })
      }
      return implementation(request)
    })
    view()
    await screen.findByRole("tab", { name: "第一页" })
    const input = screen.getByRole("textbox", { name: "向 Ego 页面输入" })
    fireEvent.keyDown(input, { key: "a" })
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: "human", tabId: "page-one" })
      )
    )
    fireEvent.keyDown(input, { key: "b" })
    fireEvent.click(screen.getByRole("tab", { name: "第二页" }))
    await act(async () => finish(structuredClone(current)))
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "human",
          tabId: "page-one",
          action: { kind: "text", text: "b" },
        })
      )
    )
  })

  it("同一控制 epoch 的旧轮询也不能把已关闭页面重新带回", async () => {
    let resolvePoll: (session: EgoSession) => void = () => {}
    const stale = structuredClone(current)
    stale.revision = 2
    current.control.owner = "device-current"
    stale.control.owner = "device-current"
    const implementation = mocks.request.getMockImplementation()!
    let visited = false
    mocks.request.mockImplementation((request: Record<string, unknown>) =>
      request.method === "session" && visited
        ? new Promise<EgoSession>((resolve) => {
            resolvePoll = resolve
          })
        : (() => {
            if (request.method === "visit") visited = true
            return implementation(request)
          })()
    )
    view()
    await screen.findByRole("tab", { name: "第一页" })
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: "session" })
      )
    )
    current.revision = 3
    fireEvent.click(screen.getByRole("button", { name: "关闭 第一页" }))
    await waitFor(() =>
      expect(
        screen.queryByRole("tab", { name: "第一页" })
      ).not.toBeInTheDocument()
    )
    stale.control.epoch = current.control.epoch
    await act(async () => {
      resolvePoll(stale)
    })
    expect(
      screen.queryByRole("tab", { name: "第一页" })
    ).not.toBeInTheDocument()
  })
})

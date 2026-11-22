import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextIntlClientProvider } from "next-intl"
import type { ReactElement } from "react"

import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import zhMessages from "@/i18n/messages/zh-CN.json"
import { BrowserWebSurface } from "./browser-web-surface"

const mocks = vi.hoisted(() => ({
  socket: {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    onopen: null as null | (() => void),
    onmessage: null as null | ((event: { data: string | ArrayBuffer }) => void),
    onerror: null,
    onclose: null,
  },
  remember: vi.fn(),
  setState: vi.fn(),
  upload: vi.fn(() => Promise.resolve()),
  download: vi.fn(() => Promise.resolve()),
  devtools: vi.fn(() =>
    Promise.resolve("https://codeg-ego.odn.cc/devtools/enter/test")
  ),
  audioStart: vi.fn(),
  audioAppend: vi.fn(),
  audioStop: vi.fn(),
  audioFailure: null as null | ((failure: unknown) => void),
  videoStart: vi.fn(),
  videoAppend: vi.fn(),
  videoStop: vi.fn(),
  videoFailure: null as null | ((failure: Error) => void),
}))
vi.mock("@/contexts/workspace-context", () => ({
  useOptionalWorkspaceActions: () => null,
}))
vi.mock("@/lib/browser/web-browser-audio", () => ({
  WebBrowserAudio: class {
    constructor(
      _element: HTMLAudioElement,
      onError: (failure: unknown) => void
    ) {
      mocks.audioFailure = onError
    }
    start = mocks.audioStart
    append = mocks.audioAppend
    stop = mocks.audioStop
  },
}))
vi.mock("@/lib/browser/web-browser-video", () => ({
  WebBrowserVideo: class {
    constructor(
      _canvas: HTMLCanvasElement,
      _onFrame: () => void,
      _onAck: (timestamp: number) => void,
      onError: (failure: Error) => void
    ) {
      mocks.videoFailure = onError
    }
    start = mocks.videoStart
    append = mocks.videoAppend
    stop = mocks.videoStop
  },
}))

vi.mock("@/lib/browser/web-browser", () => ({
  webBrowserSocket: () => mocks.socket,
  rememberWebBrowserTab: mocks.remember,
  uploadBrowserFiles: mocks.upload,
  downloadBrowserFile: mocks.download,
  webBrowserDevtools: mocks.devtools,
}))
vi.mock("@/lib/browser/browser-tab-store", () => ({
  setBrowserTabState: mocks.setState,
  useBrowserConsoleErrors: () => false,
}))

const tab = {
  id: "browser:online-test",
  browser: { initialUrl: "https://example.com/", profile: "default" },
} as BrowserWorkspaceTab

function renderSurface(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="zh-CN" messages={zhMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.socket.readyState = 1
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function receive(message: Record<string, unknown>) {
  await act(async () => {
    await mocks.socket.onmessage?.({ data: JSON.stringify(message) })
  })
}

async function openMenu(name: string) {
  const trigger = screen.getByRole("button", { name })
  await act(async () => {
    fireEvent(
      trigger,
      new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      })
    )
    fireEvent(
      trigger,
      new MouseEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        button: 0,
      })
    )
    fireEvent(
      trigger,
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      })
    )
    await Promise.resolve()
  })
}

function sent() {
  return mocks.socket.send.mock.calls.map(([raw]) => JSON.parse(raw))
}

function touch(
  canvas: HTMLElement,
  type: string,
  clientX: number,
  clientY: number,
  pointerId = 7
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
  })
  Object.defineProperties(event, {
    pointerType: { value: "touch" },
    pointerId: { value: pointerId },
    isPrimary: { value: pointerId === 7 },
  })
  fireEvent(canvas, event)
}

function renderTouchSurface() {
  const matchMedia = window.matchMedia.bind(window)
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    ...matchMedia(query),
    matches: query === "(pointer: coarse)",
  }))
  renderSurface(
    <BrowserWebSurface
      tab={tab}
      url="https://example.com/"
      reloadKey={0}
      onNavigate={vi.fn()}
    />
  )
  act(() => mocks.socket.onopen?.())
  const canvas = screen.getByLabelText("网站画面") as HTMLCanvasElement
  canvas.width = 390
  canvas.height = 844
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width: 390,
    height: 844,
    right: 390,
    bottom: 844,
    toJSON: () => ({}),
  })
  return canvas
}

describe("Web browser page input", () => {
  it("runs touch controls on pointer release even when the browser omits click", () => {
    renderTouchSurface()
    const button = screen.getByRole("button", { name: "触控板" })
    touch(button, "pointerdown", 0, 0)
    touch(button, "pointerup", 0, 0)
    expect(button).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(button, { detail: 1 })
    expect(button).toHaveAttribute("aria-pressed", "true")
    const right = screen.getByRole("button", { name: "右键" })
    touch(right, "pointerdown", 0, 0)
    touch(right, "pointerup", 0, 0)
    fireEvent.click(right, { detail: 1 })
    expect(sent().filter((message) => message.button === "right")).toHaveLength(
      2
    )
  })

  it("does not activate a control when swiping the control strip or cancelling touch", () => {
    renderTouchSurface()
    const button = screen.getByRole("button", { name: "触控板" })
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 200,
      bottom: 50,
    } as DOMRect)
    touch(button, "pointerdown", 20, 20)
    touch(button, "pointerup", 100, 20)
    expect(button).toHaveAttribute("aria-pressed", "false")
    touch(button, "pointerdown", 20, 20)
    touch(button, "pointercancel", 20, 20)
    touch(button, "pointerup", 20, 20)
    expect(button).toHaveAttribute("aria-pressed", "false")
  })

  it("uses two-finger trackpad movement for scrolling rather than a click", () => {
    const canvas = renderTouchSurface()
    fireEvent.click(screen.getByRole("button", { name: "触控板" }))
    touch(canvas, "pointerdown", 100, 400)
    touch(canvas, "pointerdown", 160, 400, 8)
    touch(canvas, "pointermove", 100, 360)
    touch(canvas, "pointermove", 160, 360, 8)
    touch(canvas, "pointerup", 160, 360, 8)
    touch(canvas, "pointerup", 100, 360)
    const pointers = sent().filter((message) => message.type === "pointer")
    expect(pointers).toHaveLength(2)
    expect(pointers.every((message) => message.event === "mouseWheel")).toBe(
      true
    )
    expect(pointers.reduce((total, message) => total + message.deltaY, 0)).toBe(
      40
    )
  })

  it("releases the remote mouse button when the client window loses focus", () => {
    renderTouchSurface()
    fireEvent.click(screen.getByRole("button", { name: "触控板" }))
    fireEvent.click(screen.getByRole("button", { name: "拖拽" }))
    fireEvent(window, new Event("blur"))
    expect(sent().at(-1)).toEqual(
      expect.objectContaining({ event: "mouseReleased", buttons: 0 })
    )
    expect(screen.getByRole("button", { name: "拖拽" })).toHaveAttribute(
      "aria-pressed",
      "false"
    )
  })

  it("keeps the same browser surface and socket when entering and leaving landscape", () => {
    vi.stubGlobal("innerWidth", 390)
    vi.stubGlobal("innerHeight", 844)
    const canvas = renderTouchSurface()
    const originalRoot = canvas.closest("[data-browser-web-surface]")
    fireEvent.click(screen.getByRole("button", { name: "横屏桌面" }))
    expect(screen.getByLabelText("网站画面")).toBe(canvas)
    expect(originalRoot).toHaveAttribute("data-browser-landscape", "rotated")
    expect(originalRoot?.parentElement?.parentElement).toBe(document.body)
    expect(mocks.socket.close).not.toHaveBeenCalled()
    expect(sent().filter((message) => message.type === "open")).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: "退出横屏" }))
    expect(screen.getByLabelText("网站画面")).toBe(canvas)
    expect(originalRoot).not.toHaveAttribute("data-browser-landscape")
    expect(originalRoot?.parentElement?.parentElement).not.toBe(document.body)
    expect(mocks.socket.close).not.toHaveBeenCalled()
  })

  it("maps touch coordinates back from the rotated desktop view", () => {
    vi.stubGlobal("innerWidth", 390)
    vi.stubGlobal("innerHeight", 844)
    const canvas = renderTouchSurface()
    fireEvent.click(screen.getByRole("button", { name: "横屏桌面" }))
    canvas.width = 1280
    canvas.height = 600
    vi.mocked(canvas.getBoundingClientRect).mockReturnValue({
      left: 0,
      top: 0,
      right: 600,
      bottom: 1280,
      width: 600,
      height: 1280,
    } as DOMRect)
    touch(canvas, "pointerdown", 450, 320)
    touch(canvas, "pointerup", 450, 320)
    expect(sent().filter((message) => message.type === "pointer")).toEqual([
      expect.objectContaining({ event: "mousePressed", x: 320, y: 150 }),
      expect.objectContaining({ event: "mouseReleased", x: 320, y: 150 }),
    ])
  })

  it("switches to a desktop-width viewport without opening another browser connection", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("innerWidth", 390)
    vi.stubGlobal("innerHeight", 844)
    try {
      const canvas = renderTouchSurface()
      const measure = vi
        .spyOn(canvas.parentElement!, "getBoundingClientRect")
        .mockReturnValue({ width: 390, height: 700 } as DOMRect)
      await act(() => vi.advanceTimersByTimeAsync(150))
      expect(
        sent()
          .filter((message) => message.type === "resize")
          .at(-1)
      ).toEqual({
        type: "resize",
        width: 390,
        height: 700,
        mobile: true,
      })
      measure.mockReturnValue({ width: 300, height: 844 } as DOMRect)
      fireEvent.click(screen.getByRole("button", { name: "横屏桌面" }))
      await act(() => vi.advanceTimersByTimeAsync(150))
      expect(
        sent()
          .filter((message) => message.type === "resize")
          .at(-1)
      ).toEqual({
        type: "resize",
        width: 1280,
        height: 455,
        mobile: false,
      })
      expect(mocks.socket.close).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("moves the relative pointer and releases a held drag on mode change", () => {
    const canvas = renderTouchSurface()
    fireEvent.click(screen.getByRole("button", { name: "触控板" }))
    fireEvent.click(screen.getByRole("button", { name: "拖拽" }))
    touch(canvas, "pointerdown", 100, 150)
    touch(canvas, "pointermove", 130, 170)
    touch(canvas, "pointerup", 130, 170)
    const moved = sent().filter((message) => message.event === "mouseMoved")
    expect(moved).toHaveLength(1)
    expect(moved[0]).toEqual(
      expect.objectContaining({ buttons: 1, button: "left" })
    )
    expect(
      sent().filter((message) => message.event === "mouseReleased")
    ).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: "触控板" }))
    expect(sent().at(-1)).toEqual(
      expect.objectContaining({ event: "mouseReleased", buttons: 0 })
    )
    expect(screen.queryByRole("button", { name: "右键" })).toBeNull()
  })

  it("sends right-click and special keys without navigating or refreshing", () => {
    renderTouchSurface()
    fireEvent.click(screen.getByRole("button", { name: "触控板" }))
    fireEvent.click(screen.getByRole("button", { name: "右键" }))
    expect(sent().slice(-2)).toEqual([
      expect.objectContaining({
        event: "mousePressed",
        button: "right",
        buttons: 2,
      }),
      expect.objectContaining({
        event: "mouseReleased",
        button: "right",
        buttons: 0,
      }),
    ])
    fireEvent.click(screen.getByRole("button", { name: "打开键盘" }))
    fireEvent.click(screen.getByRole("button", { name: "Ctrl+A" }))
    expect(sent().slice(-2)).toEqual([
      {
        type: "key",
        event: "keyDown",
        key: "a",
        code: "KeyA",
        keyCode: 65,
        modifiers: 2,
        commands: ["selectAll"],
      },
      {
        type: "key",
        event: "keyUp",
        key: "a",
        code: "KeyA",
        keyCode: 65,
        modifiers: 2,
      },
    ])
    expect(
      sent().some((message) => ["navigate", "reload"].includes(message.type))
    ).toBe(false)
  })

  it("does not add phone controls on a mouse-driven desktop", () => {
    renderSurface(
      <BrowserWebSurface
        tab={tab}
        url="https://example.com/"
        onNavigate={vi.fn()}
      />
    )
    expect(screen.queryByRole("toolbar", { name: "浏览器触控操作" })).toBeNull()
  })

  it("taps a page once without opening the phone keyboard", () => {
    const canvas = renderTouchSurface()
    const input = screen.getByRole("textbox", { name: "向网站输入文字" })
    touch(canvas, "pointerdown", 100, 150)
    expect(sent().filter((message) => message.type === "pointer")).toEqual([])
    touch(canvas, "pointerup", 100, 150)
    expect(input).not.toHaveFocus()
    expect(sent().filter((message) => message.type === "pointer")).toEqual([
      expect.objectContaining({
        event: "mousePressed",
        x: 100,
        y: 150,
        button: "left",
      }),
      expect.objectContaining({
        event: "mouseReleased",
        x: 100,
        y: 150,
        button: "left",
      }),
    ])
  })

  it("scrolls a touch swipe without clicking or dragging page content", () => {
    const canvas = renderTouchSurface()
    touch(canvas, "pointerdown", 150, 550)
    touch(canvas, "pointermove", 150, 500)
    touch(canvas, "pointermove", 150, 450)
    touch(canvas, "pointerup", 150, 450)
    const pointers = sent().filter((message) => message.type === "pointer")
    expect(pointers.length).toBeGreaterThan(0)
    expect(pointers.every((message) => message.event === "mouseWheel")).toBe(
      true
    )
    expect(pointers.reduce((sum, message) => sum + message.deltaY, 0)).toBe(100)
    expect(
      screen.getByRole("textbox", { name: "向网站输入文字" })
    ).not.toHaveFocus()
  })

  it("cancels a touch without sending a click", () => {
    const canvas = renderTouchSurface()
    touch(canvas, "pointerdown", 150, 400)
    touch(canvas, "pointercancel", 150, 400)
    touch(canvas, "pointerup", 150, 400)
    expect(sent().filter((message) => message.type === "pointer")).toEqual([])
  })

  it("opens the phone keyboard only through its keyboard control", () => {
    const canvas = renderTouchSurface()
    const input = screen.getByRole("textbox", { name: "向网站输入文字" })
    const button = screen.getByRole("button", { name: "打开键盘" })
    fireEvent.click(button)
    expect(input).toHaveFocus()
    fireEvent.compositionEnd(input, { data: "手机输入" })
    expect(sent()).toContainEqual({ type: "text", text: "手机输入" })
    touch(canvas, "pointerdown", 150, 400)
    touch(canvas, "pointerup", 150, 400)
    expect(input).not.toHaveFocus()
  })

  it("keeps the remote viewport stable while the phone keyboard covers its bottom", async () => {
    vi.useFakeTimers()
    let resize!: ResizeObserverCallback
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback
        }
        observe() {}
        disconnect() {}
      }
    )
    try {
      const canvas = renderTouchSurface()
      const container = canvas.parentElement!
      const measure = vi
        .spyOn(container, "getBoundingClientRect")
        .mockReturnValue({ width: 390, height: 740 } as DOMRect)
      await act(() => vi.advanceTimersByTimeAsync(150))
      expect(
        sent().filter((message) => message.type === "resize")
      ).toContainEqual({
        type: "resize",
        width: 390,
        height: 740,
        mobile: true,
      })
      const input = screen.getByRole("textbox", { name: "向网站输入文字" })
      act(() => input.focus())
      measure.mockReturnValue({ width: 390, height: 400 } as DOMRect)
      act(() => resize([], {} as ResizeObserver))
      await act(() => vi.advanceTimersByTimeAsync(150))
      expect(
        sent().filter((message) => message.type === "resize")
      ).toHaveLength(1)
      expect(canvas.style.height).toBe("auto")
      expect(canvas.closest("[data-browser-device-stage]")).toHaveAttribute(
        "data-browser-device-stage",
        "desktop"
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("draws binary JPEG frames and ignores an older frame that decodes later", async () => {
    const decoding: ((bitmap: ImageBitmap) => void)[] = []
    const decode = vi.fn(
      (blob: Blob) =>
        new Promise<ImageBitmap>((resolve) => {
          expect(blob.type).toBe("image/jpeg")
          decoding.push(resolve)
        })
    )
    vi.stubGlobal("createImageBitmap", decode)
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D)
    renderSurface(
      <BrowserWebSurface
        tab={tab}
        url="https://example.com/"
        reloadKey={0}
        onNavigate={vi.fn()}
      />
    )
    act(() => mocks.socket.onopen?.())
    expect(sent()[0]).toMatchObject({ frameProtocol: "jpeg-v2" })
    const frames: Promise<void>[] = []
    act(() => {
      for (const id of [11, 12]) {
        const packet = new ArrayBuffer(7)
        new DataView(packet).setUint32(0, id)
        new Uint8Array(packet, 4).set([255, 216, 255])
        frames.push(
          mocks.socket.onmessage?.({
            data: packet,
          }) as unknown as Promise<void>
        )
      }
    })
    expect(decode.mock.calls[0][0]).toMatchObject({
      size: 3,
      type: "image/jpeg",
    })
    const newer = {
      width: 1280,
      height: 800,
      close: vi.fn(),
    } as unknown as ImageBitmap
    const older = {
      width: 1280,
      height: 800,
      close: vi.fn(),
    } as unknown as ImageBitmap
    await act(async () => {
      decoding[1](newer)
      await frames[1]
      decoding[0](older)
      await frames[0]
    })
    expect(drawImage).toHaveBeenCalledOnce()
    expect(drawImage).toHaveBeenCalledWith(newer, 0, 0)
    expect(older.close).toHaveBeenCalledOnce()
    expect(sent().filter((message) => message.type === "frame-ack")).toEqual([
      { type: "frame-ack", id: 12 },
      { type: "frame-ack", id: 11 },
    ])
  })

  it("acknowledges a frame only after decoding and drawing it", async () => {
    let finishDecode!: (bitmap: ImageBitmap) => void
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(
        () =>
          new Promise<ImageBitmap>((resolve) => {
            finishDecode = resolve
          })
      )
    )
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D)
    renderSurface(
      <BrowserWebSurface
        tab={tab}
        url="https://example.com/"
        reloadKey={0}
        onNavigate={vi.fn()}
      />
    )
    act(() => mocks.socket.onopen?.())
    expect(sent()[0]).toMatchObject({ type: "open", flowControl: true })
    let drawing: Promise<void> | undefined
    act(() => {
      drawing = mocks.socket.onmessage?.({
        data: JSON.stringify({ type: "frame", id: 7, data: "YWJj" }),
      }) as unknown as Promise<void>
    })
    expect(sent().some((message) => message.type === "frame-ack")).toBe(false)
    await act(async () => {
      finishDecode({
        width: 1280,
        height: 800,
        close: vi.fn(),
      } as unknown as ImageBitmap)
      await drawing
    })
    expect(drawImage).toHaveBeenCalledOnce()
    expect(sent().at(-1)).toEqual({ type: "frame-ack", id: 7 })
  })

  it("decodes JPEG frames with an Image fallback when ImageBitmap is unavailable", async () => {
    vi.stubGlobal("createImageBitmap", undefined)
    const createObjectURL = vi.fn(() => "blob:browser-frame")
    const revokeObjectURL = vi.fn()
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL })
    class FakeImage {
      naturalWidth = 640
      naturalHeight = 480
      width = 640
      height = 480
      onload: (() => void) | null = null
      onerror: (() => void) | null = null

      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
    vi.stubGlobal("Image", FakeImage)
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D)
    renderSurface(
      <BrowserWebSurface
        tab={tab}
        url="https://example.com/"
        reloadKey={0}
        onNavigate={vi.fn()}
      />
    )
    act(() => mocks.socket.onopen?.())
    await act(async () => {
      await mocks.socket.onmessage?.({
        data: JSON.stringify({ type: "frame", id: 8, data: "YWJj" }),
      })
    })
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(drawImage).toHaveBeenCalledWith(expect.any(FakeImage), 0, 0)
    expect(sent().at(-1)).toEqual({ type: "frame-ack", id: 8 })
  })

  it("stops audio and clears permissions on disconnect, ignoring the old socket", async () => {
    renderSurface(
      <BrowserWebSurface
        tab={tab}
        url="https://example.com/"
        reloadKey={0}
        onNavigate={vi.fn()}
      />
    )
    act(() => mocks.socket.onopen?.())
    await receive({ type: "audio-start", mime: "audio/webm;codecs=opus" })
    await receive({
      type: "state",
      url: "https://example.com/",
      grant: "control",
    })
    await receive({
      type: "eval-request",
      requestId: "disconnected",
      expression: "document.title",
    })
    const oldMessage = mocks.socket.onmessage
    act(() => {
      const onclose = mocks.socket.onclose as unknown as (event: {
        code: number
      }) => void
      onclose({ code: 4001 })
    })
    expect(mocks.audioStop).toHaveBeenCalled()
    expect(screen.getByLabelText("网站声音播放器")).toHaveAttribute("hidden")
    expect(screen.queryByRole("dialog", { name: "Agent 脚本授权" })).toBeNull()
    expect(screen.getByRole("button", { name: "共享给智能体" })).toBeDisabled()
    await act(async () => {
      await oldMessage?.({
        data: JSON.stringify({
          type: "audio-start",
          mime: "audio/webm;codecs=opus",
        }),
      })
    })
    expect(mocks.audioStart).toHaveBeenCalledOnce()
  })

  it.each([
    { url: "https://other.example/", grant: "control" },
    { url: "https://example.com/", grant: "none" },
  ])(
    "clears an obsolete script approval on state $url $grant",
    async (state) => {
      renderSurface(
        <BrowserWebSurface
          tab={tab}
          url="https://example.com/"
          reloadKey={0}
          onNavigate={vi.fn()}
        />
      )
      act(() => mocks.socket.onopen?.())
      await receive({
        type: "state",
        url: "https://example.com/",
        grant: "control",
      })
      await receive({
        type: "eval-request",
        requestId: "old-page",
        expression: "document.title",
      })
      await receive({ type: "state", ...state })
      expect(
        screen.queryByRole("dialog", { name: "Agent 脚本授权" })
      ).toBeNull()
    }
  )

  it("reports asynchronous playback errors and immediately disables audio", async () => {
    renderSurface(
      <BrowserWebSurface
        tab={tab}
        url="https://example.com/"
        reloadKey={0}
        onNavigate={vi.fn()}
      />
    )
    act(() => mocks.socket.onopen?.())
    await receive({ type: "audio-start", mime: "audio/webm;codecs=opus" })
    act(() => mocks.audioFailure?.(new Error("decode failed")))
    expect(sent().slice(-1)[0]).toEqual({ type: "audio", enabled: false })
    expect(screen.getByRole("alert")).toHaveTextContent("decode failed")
    expect(screen.getByLabelText("网站声音播放器")).toHaveAttribute("hidden")
  })

  it("shows VP8 decoder failures before falling back to compatible frames", async () => {
    renderSurface(
      <BrowserWebSurface
        tab={tab}
        url="https://example.com/"
        reloadKey={0}
        onNavigate={vi.fn()}
      />
    )
    act(() => mocks.socket.onopen?.())
    await receive({ type: "video-start", codec: "vp8" })
    act(() => mocks.videoFailure?.(new Error("decoder rejected frame")))
    expect(
      screen.getByText("视频解码失败，已切换兼容画面：decoder rejected frame")
    ).toBeInTheDocument()
    expect(sent().at(-1)).toEqual({ type: "video-fallback" })
    expect(mocks.videoStop).toHaveBeenCalledOnce()
  })

  it("plays received audio, opens the real inspector, and grants access only on user selection", async () => {
    renderSurface(
      <BrowserWebSurface
        tab={tab}
        url="https://example.com/"
        reloadKey={0}
        onNavigate={vi.fn()}
      />
    )
    act(() => mocks.socket.onopen?.())
    await receive({
      type: "state",
      url: "https://example.com/",
      grant: "none",
      back: false,
      forward: false,
    })
    await openMenu("更多")
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "播放网站声音" })
    )
    expect(sent().slice(-1)[0]).toEqual({ type: "audio", enabled: true })
    await receive({ type: "audio-start", mime: "audio/webm;codecs=opus" })
    await receive({ type: "audio", data: "YWJj" })
    expect(mocks.audioStart).toHaveBeenCalledWith("audio/webm;codecs=opus")
    expect(mocks.audioAppend).toHaveBeenCalledWith("YWJj")
    expect(screen.getByLabelText("网站声音播放器")).not.toHaveAttribute(
      "hidden"
    )
    await openMenu("更多")
    fireEvent.click(await screen.findByRole("menuitem", { name: "打开检查器" }))
    await screen.findByTitle("网站开发者工具")
    expect(mocks.devtools).toHaveBeenCalledWith(tab.id)
    await openMenu("共享给智能体")
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "读取并操作权限" })
    )
    expect(sent().slice(-1)[0]).toEqual({ type: "share", level: "control" })
    await receive({
      type: "eval-request",
      requestId: "exact-snippet",
      expression: "document.title",
    })
    expect(
      screen.getByRole("dialog", { name: "Agent 脚本授权" })
    ).toHaveTextContent("document.title")
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }))
    expect(sent().slice(-1)[0]).toEqual({
      type: "eval-answer",
      requestId: "exact-snippet",
      approved: false,
    })
  })
  it("updates the address and persistence from page navigation without reopening the socket", async () => {
    const onNavigate = vi.fn()
    const view = renderSurface(
      <BrowserWebSurface
        tab={tab}
        url="https://example.com/"
        reloadKey={0}
        onNavigate={onNavigate}
      />
    )
    act(() => mocks.socket.onopen?.())
    await receive({
      type: "state",
      url: "https://example.com/docs",
      title: "Documentation",
      back: true,
      forward: false,
    })
    expect(onNavigate).toHaveBeenCalledWith("https://example.com/docs")
    expect(mocks.setState).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/docs",
        title: "Documentation",
      })
    )
    view.rerender(
      <NextIntlClientProvider locale="zh-CN" messages={zhMessages}>
        <BrowserWebSurface
          tab={tab}
          url="https://example.com/docs"
          reloadKey={0}
          onNavigate={onNavigate}
        />
      </NextIntlClientProvider>
    )
    expect(
      sent().filter((message) => message.type === "navigate")
    ).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: "后退" }))
    expect(sent().slice(-1)[0]).toEqual({ type: "history", direction: "back" })
    view.rerender(
      <NextIntlClientProvider locale="zh-CN" messages={zhMessages}>
        <BrowserWebSurface
          tab={tab}
          url="https://example.org/"
          reloadKey={1}
          onNavigate={onNavigate}
        />
      </NextIntlClientProvider>
    )
    expect(sent()).toContainEqual({
      type: "navigate",
      url: "https://example.org/",
    })
    expect(sent()).toContainEqual({ type: "reload" })
  })

  it("maps clicks through letterboxing and forwards Chinese composition only once", () => {
    vi.stubGlobal("PointerEvent", MouseEvent)
    renderSurface(
      <BrowserWebSurface
        tab={tab}
        url="https://example.com/"
        reloadKey={0}
        onNavigate={vi.fn()}
      />
    )
    const canvas = screen.getByLabelText("网站画面") as HTMLCanvasElement
    canvas.width = 1280
    canvas.height = 800
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      width: 400,
      height: 600,
      right: 410,
      bottom: 620,
      toJSON: () => ({}),
    })
    fireEvent.pointerDown(canvas, {
      clientX: 210,
      clientY: 120,
      button: 0,
      buttons: 1,
      pointerId: 1,
    })
    expect(sent().slice(-1)[0]).toEqual(
      expect.objectContaining({
        type: "pointer",
        x: 640,
        y: 320,
        button: "left",
      })
    )
    const text = screen.getByRole("textbox", { name: "向网站输入文字" })
    fireEvent.compositionStart(text)
    fireEvent.compositionEnd(text, { data: "中文输入" })
    expect(sent().filter((message) => message.type === "text")).toEqual([
      { type: "text", text: "中文输入" },
    ])
    fireEvent.keyDown(text, { key: "Enter", code: "Enter", keyCode: 13 })
    expect(sent().slice(-1)[0]).toEqual(
      expect.objectContaining({ type: "key", key: "Enter", keyCode: 13 })
    )
  })

  it("shows website dialogs and explicitly accepts file upload from this device", async () => {
    const view = renderSurface(
      <BrowserWebSurface
        tab={tab}
        url="https://example.com/"
        reloadKey={0}
        onNavigate={vi.fn()}
      />
    )
    await receive({
      type: "dialog",
      message: "Continue?",
      dialogType: "prompt",
      defaultPrompt: "value",
    })
    fireEvent.change(screen.getByLabelText("网站提示输入"), {
      target: { value: "answer" },
    })
    fireEvent.click(screen.getByRole("button", { name: "确定" }))
    expect(sent().slice(-1)[0]).toEqual({
      type: "dialog",
      accept: true,
      text: "answer",
    })
    await receive({ type: "upload", multiple: false })
    expect(
      screen.getByRole("button", { name: "选择文件上传到网站" })
    ).toBeVisible()
    const file = new File(["file body"], "example.txt")
    fireEvent.change(view.container.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    })
    await waitFor(() =>
      expect(mocks.upload).toHaveBeenCalledWith(tab.id, [file])
    )
    await receive({ type: "download", id: "file-id", name: "example.txt" })
    fireEvent.click(screen.getByRole("button", { name: "下载 example.txt" }))
    expect(mocks.download).toHaveBeenCalledWith(
      tab.id,
      "file-id",
      "example.txt"
    )
  })
})

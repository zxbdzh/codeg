import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import { BrowserWebSurface } from "./browser-web-surface"

const mocks = vi.hoisted(() => ({
  socket: {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    onopen: null as null | (() => void),
    onmessage: null as null | ((event: { data: string }) => void),
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

vi.mock("@/lib/browser/web-browser", () => ({
  webBrowserSocket: () => mocks.socket,
  rememberWebBrowserTab: mocks.remember,
  uploadBrowserFiles: mocks.upload,
  downloadBrowserFile: mocks.download,
  webBrowserDevtools: mocks.devtools,
}))
vi.mock("@/lib/browser/browser-tab-store", () => ({
  setBrowserTabState: mocks.setState,
}))

const tab = {
  id: "browser:online-test",
  browser: { initialUrl: "https://example.com/", profile: "default" },
} as BrowserWorkspaceTab

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

function sent() {
  return mocks.socket.send.mock.calls.map(([raw]) => JSON.parse(raw))
}

describe("Web browser page input", () => {
  it("stops audio and clears permissions on disconnect, ignoring the old socket", async () => {
    render(
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
    expect(
      screen.getByRole("combobox", { name: "Agent 访问权限" })
    ).toBeDisabled()
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
      render(
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
    render(
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

  it("plays received audio, opens the real inspector, and grants access only on user selection", async () => {
    render(
      <BrowserWebSurface
        tab={tab}
        url="https://example.com/"
        reloadKey={0}
        onNavigate={vi.fn()}
      />
    )
    act(() => mocks.socket.onopen?.())
    fireEvent.click(screen.getByRole("button", { name: "播放网站声音" }))
    expect(sent().slice(-1)[0]).toEqual({ type: "audio", enabled: true })
    await receive({ type: "audio-start", mime: "audio/webm;codecs=opus" })
    await receive({ type: "audio", data: "YWJj" })
    expect(mocks.audioStart).toHaveBeenCalledWith("audio/webm;codecs=opus")
    expect(mocks.audioAppend).toHaveBeenCalledWith("YWJj")
    expect(screen.getByLabelText("网站声音播放器")).not.toHaveAttribute(
      "hidden"
    )
    fireEvent.click(screen.getByRole("button", { name: "开发者工具" }))
    await screen.findByTitle("网站开发者工具")
    expect(mocks.devtools).toHaveBeenCalledWith(tab.id)
    fireEvent.change(screen.getByRole("combobox", { name: "Agent 访问权限" }), {
      target: { value: "control" },
    })
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
    const view = render(
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
      <BrowserWebSurface
        tab={tab}
        url="https://example.com/docs"
        reloadKey={0}
        onNavigate={onNavigate}
      />
    )
    expect(
      sent().filter((message) => message.type === "navigate")
    ).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: "后退" }))
    expect(sent().slice(-1)[0]).toEqual({ type: "history", direction: "back" })
    view.rerender(
      <BrowserWebSurface
        tab={tab}
        url="https://example.org/"
        reloadKey={1}
        onNavigate={onNavigate}
      />
    )
    expect(sent()).toContainEqual({
      type: "navigate",
      url: "https://example.org/",
    })
    expect(sent()).toContainEqual({ type: "reload" })
  })

  it("maps clicks through letterboxing and forwards Chinese composition only once", () => {
    vi.stubGlobal("PointerEvent", MouseEvent)
    render(
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
    const view = render(
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

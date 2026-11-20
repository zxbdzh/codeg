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
}))

vi.mock("@/lib/browser/web-browser", () => ({
  webBrowserSocket: () => mocks.socket,
  rememberWebBrowserTab: mocks.remember,
  uploadBrowserFiles: mocks.upload,
  downloadBrowserFile: mocks.download,
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
    expect(sent().at(-1)).toEqual({ type: "history", direction: "back" })
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
    expect(sent().at(-1)).toEqual(
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
    expect(sent().at(-1)).toEqual(
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
    expect(sent().at(-1)).toEqual({
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

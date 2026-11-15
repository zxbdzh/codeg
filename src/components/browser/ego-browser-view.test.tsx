import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { EgoSession } from "@/lib/browser/ego-api"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("@/lib/browser/ego-api", async (original) => ({
  ...(await original<typeof import("@/lib/browser/ego-api")>()),
  egoRequest: mocks.request,
}))
vi.mock("@/lib/api", () => ({ uploadAttachment: vi.fn() }))

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
          const action = request.action as { kind: string }
          current = {
            ...current,
            revision: current.revision + 1,
            control: {
              ...current.control,
              owner: "device-current",
              epoch: current.control.epoch + 1,
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
  afterEach(() => vi.restoreAllMocks())

  function view() {
    return render(
      <EgoBrowserView
        sessionId={7}
        viewId="view-seven"
        initialUrl="https://example.com/one"
      />
    )
  }

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

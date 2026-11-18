import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("./ego-api", () => ({
  egoRequest: mocks.request,
  egoClientId: () => "this-device",
}))
import {
  guardEgoWorkspaceClose,
  publishEgoSession,
  registerEgoView,
} from "./ego-workspace"
import type { EgoSession } from "./ego-api"

function connectedView(id: string, sessionId: number) {
  registerEgoView(id, sessionId, Promise.resolve())
  const session: EgoSession = {
    sessionId,
    revision: 1,
    spaceId: sessionId,
    tabs: [{ id: `${id}-page`, url: "about:blank", title: "", live: true }],
    views: { [id]: `${id}-page` },
    downloads: [],
    control: { owner: null, epoch: 1, recoveryRequired: false },
    connected: true,
    blocked: null,
    evalRequest: null,
  }
  publishEgoSession(session)
  return session
}

describe("Ego 工作区标签关闭", () => {
  it("尚未连接成功时立即关闭本地入口，不等待或重新启动连接", () => {
    mocks.request.mockClear()
    registerEgoView("close-pending", 101, new Promise(() => {}))
    const retry = vi.fn()
    const failed = vi.fn()

    expect(guardEgoWorkspaceClose(["close-pending"], retry, failed)).toBe(false)
    expect(mocks.request).not.toHaveBeenCalled()
    expect(failed).not.toHaveBeenCalled()
  })

  it("连接失败后仍能关闭入口，不再请求会话状态", async () => {
    mocks.request.mockClear()
    const pending = Promise.reject(new Error("Ego bridge timeout"))
    void pending.catch(() => {})
    registerEgoView("close-unconnected", 102, pending)
    await expect(pending).rejects.toThrow("Ego bridge timeout")

    expect(
      guardEgoWorkspaceClose(["close-unconnected"], vi.fn(), vi.fn())
    ).toBe(false)
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it("已断线的页面可以关闭入口，保留执行端真实页面", () => {
    mocks.request.mockClear()
    const session = connectedView("close-disconnected", 103)
    publishEgoSession({ ...session, revision: 2, connected: false })

    expect(
      guardEgoWorkspaceClose(["close-disconnected"], vi.fn(), vi.fn())
    ).toBe(false)
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it("等待真实页面关闭后才移除标签，关闭不隐式交还 Agent", async () => {
    let finish: (value: unknown) => void = () => {}
    mocks.request.mockImplementation((request) =>
      request.method === "session"
        ? Promise.resolve({ control: { epoch: 11 } })
        : new Promise((resolve) => {
            finish = resolve
          })
    )
    connectedView("close-success", 7)
    const retry = vi.fn()
    const failed = vi.fn()
    expect(guardEgoWorkspaceClose(["close-success"], retry, failed)).toBe(true)
    await vi.waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith({
        method: "closeView",
        sessionId: 7,
        viewId: "close-success",
        clientId: "this-device",
        epoch: 11,
      })
    )
    expect(retry).not.toHaveBeenCalled()
    finish({})
    await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce())
    expect(failed).not.toHaveBeenCalled()
    expect(guardEgoWorkspaceClose(["close-success"], retry, failed)).toBe(false)
  })

  it("关闭时才发现连接中断，也能移除本地入口", async () => {
    mocks.request.mockClear()
    mocks.request.mockRejectedValue(new Error("connection_lost"))
    connectedView("close-lost", 104)
    const retry = vi.fn()
    const failed = vi.fn()

    expect(guardEgoWorkspaceClose(["close-lost"], retry, failed)).toBe(true)
    await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce())
    expect(failed).not.toHaveBeenCalled()
    expect(
      mocks.request.mock.calls.some(
        ([request]) => request.method === "closeView"
      )
    ).toBe(false)
    expect(guardEgoWorkspaceClose(["close-lost"], retry, failed)).toBe(false)
  })

  it("只读设备或离线关闭失败时保留标签并显示真实原因", async () => {
    mocks.request.mockImplementation(async (request) => {
      if (request.method === "session") return { control: { epoch: 12 } }
      throw new Error("read_only")
    })
    connectedView("close-failed", 8)
    const retry = vi.fn()
    const failed = vi.fn()
    guardEgoWorkspaceClose(["close-failed"], retry, failed)
    await vi.waitFor(() =>
      expect(failed).toHaveBeenCalledWith(
        expect.objectContaining({ message: "read_only" })
      )
    )
    expect(retry).not.toHaveBeenCalled()
  })
})

import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("./ego-api", () => ({
  egoRequest: mocks.request,
  egoClientId: () => "this-device",
}))
import { guardEgoWorkspaceClose, registerEgoView } from "./ego-workspace"

describe("Ego 工作区标签关闭", () => {
  it("等待真实页面关闭后才移除标签，关闭不隐式交还 Agent", async () => {
    let finish: (value: unknown) => void = () => {}
    mocks.request.mockImplementation((request) =>
      request.method === "session"
        ? Promise.resolve({ control: { epoch: 11 } })
        : new Promise((resolve) => {
            finish = resolve
          })
    )
    registerEgoView("close-success", 7, Promise.resolve())
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

  it("只读设备或离线关闭失败时保留标签并显示真实原因", async () => {
    mocks.request.mockImplementation(async (request) => {
      if (request.method === "session") return { control: { epoch: 12 } }
      throw new Error("read_only")
    })
    registerEgoView("close-failed", 8, Promise.resolve())
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

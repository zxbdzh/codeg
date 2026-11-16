import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/transport", () => ({
  getServerBaseUrl: () => "http://test",
  isDesktop: () => false,
}))
vi.mock("@/lib/transport/web-auth", () => ({
  getCodegToken: () => "secret",
  codegAuthHeaders: () => ({ Authorization: "Bearer secret" }),
}))
import { watchEgoVideo } from "./ego-video-stream"

afterEach(() => vi.unstubAllGlobals())
describe("Ego 视频兼容回退", () => {
  it("没有 requestVideoFrameCallback 时仍尝试媒体事件播放，不直接禁用视频", () => {
    class Source extends EventTarget {
      static isTypeSupported() {
        return true
      }
    }
    vi.stubGlobal("MediaSource", Source)
    const create = vi.fn().mockReturnValue("blob:video")
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: vi.fn() })
    const video = document.createElement("video")
    Object.defineProperty(video, "requestVideoFrameCallback", {
      value: undefined,
    })
    video.load = vi.fn()
    const cancel = watchEgoVideo(video, 7, "page", vi.fn(), vi.fn())
    expect(cancel).not.toBeNull()
    cancel?.()
  })
  it("不支持 MSE 时返回原通道且不发网络请求", () => {
    vi.stubGlobal("MediaSource", undefined)
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    expect(
      watchEgoVideo(
        document.createElement("video"),
        7,
        "page",
        vi.fn(),
        vi.fn()
      )
    ).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("服务拒绝视频时重试三次并报告 HTTP 原因，不再静默回退", async () => {
    class Source extends EventTarget {
      static isTypeSupported() {
        return true
      }
      constructor() {
        super()
        setTimeout(() => this.dispatchEvent(new Event("sourceopen")), 0)
      }
      addSourceBuffer() {
        return new EventTarget()
      }
    }
    vi.stubGlobal("MediaSource", Source)
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:video",
      revokeObjectURL: vi.fn(),
    })
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, headers: new Headers() })
    vi.stubGlobal("fetch", fetch)
    const video = document.createElement("video")
    video.load = vi.fn()
    const fallback = vi.fn()
    const cancel = watchEgoVideo(video, 7, "page", vi.fn(), fallback)
    await vi.waitFor(() =>
      expect(fallback).toHaveBeenCalledWith(expect.stringContaining("401"))
    )
    expect(fetch).toHaveBeenCalledTimes(3)
    cancel?.()
  })
})

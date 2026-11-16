import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/transport", () => ({
  getServerBaseUrl: () => "http://test",
  isDesktop: () => false,
}))
vi.mock("@/lib/transport/web-auth", () => ({
  getCodegToken: () => "private-token",
  codegAuthHeaders: () => ({ Authorization: "Bearer private-token" }),
}))

import { watchEgoFrames } from "./ego-frame-stream"

afterEach(() => vi.unstubAllGlobals())

describe("Ego 画面流", () => {
  it("增量解析跨网络块的帧，不将令牌写入 URL，取消不触发失败重试", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
      },
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body })
    vi.stubGlobal("fetch", fetchMock)
    const receive = vi.fn()
    const stopped = vi.fn()
    const cancel = watchEgoFrames(7, "page", receive, stopped)!
    const encoder = new TextEncoder()
    streamController!.enqueue(encoder.encode('{"data":"first","width":800,'))
    streamController!.enqueue(
      encoder.encode(
        '"height":600}\n\n{"data":"second","width":800,"height":600}\n'
      )
    )
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce())
    expect(receive.mock.calls[0][0].data).toBe("second")
    expect(fetchMock.mock.calls[0][0]).toBe("http://test/api/ego_stream")
    expect(fetchMock.mock.calls[0][1].body).toBe(
      '{"sessionId":7,"tabId":"page"}'
    )
    cancel()
    streamController!.close()
    await vi.waitFor(() => expect(stopped).not.toHaveBeenCalled())
  })

  it("旧服务拒绝推流时显式回退，不报告虚构帧", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }))
    const receive = vi.fn()
    const stopped = vi.fn()
    watchEgoFrames(7, "page", receive, stopped)
    await vi.waitFor(() => expect(stopped).toHaveBeenCalledOnce())
    expect(receive).not.toHaveBeenCalled()
  })

  it("同一网络块积压的多帧只交付最后一帧，避免解码旧画面拖慢滚动", async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            '{"data":"old","width":800,"height":600}\n{"data":"latest","width":800,"height":600}\n'
          )
        )
        controller.close()
      },
    })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body }))
    const receive = vi.fn()
    watchEgoFrames(7, "page", receive, vi.fn())
    await vi.waitFor(() => expect(receive).toHaveBeenCalled())
    expect(receive).toHaveBeenCalledOnce()
    expect(receive.mock.calls[0][0].data).toBe("latest")
  })
})

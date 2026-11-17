import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("./ego-api", () => ({
  egoRequest: mocks.request,
  egoError: (reason: unknown) => String(reason),
}))
vi.mock("@/lib/transport", () => ({ isDesktop: () => false }))

import { watchEgoRtc } from "./ego-rtc-stream"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("Ego WebRTC 会话接收", () => {
  it("首个真实呈现帧立即显示，不等待每秒统计，取消后旧帧无效", async () => {
    vi.useFakeTimers()
    let present: VideoFrameRequestCallback = () => {}
    const channel = { readyState: "open", close: vi.fn(), send: vi.fn() }
    class Peer extends EventTarget {
      static instance: Peer
      iceGatheringState = "complete"
      connectionState = "connected"
      localDescription = { type: "offer", sdp: "offer" }
      ontrack: ((event: unknown) => void) | null = null
      constructor() {
        super()
        Peer.instance = this
      }
      createDataChannel() {
        return channel
      }
      addTransceiver() {}
      async createOffer() {
        return this.localDescription
      }
      async setLocalDescription() {}
      async setRemoteDescription() {}
      close() {}
      getStats = vi.fn(async () => new Map())
    }
    vi.stubGlobal("RTCPeerConnection", Peer)
    mocks.request.mockReset()
    mocks.request.mockResolvedValue({
      id: "first",
      answer: {},
      capture: "cdp-canvas",
    })
    const video = document.createElement("video")
    Object.defineProperties(video, {
      readyState: { value: 2 },
      videoWidth: { value: 1280 },
      videoHeight: { value: 720 },
      requestVideoFrameCallback: {
        value: vi.fn((callback) => {
          present = callback
          return 1
        }),
      },
      cancelVideoFrameCallback: { value: vi.fn() },
    })
    vi.spyOn(video, "play").mockResolvedValue()
    const playing = vi.fn()
    const handle = watchEgoRtc(
      video,
      7,
      "page",
      "view",
      "device",
      playing,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn()
    )!
    await vi.advanceTimersByTimeAsync(0)
    Peer.instance.ontrack!({ streams: [{}] })
    expect(playing).not.toHaveBeenCalled()
    present(16, {} as VideoFrameCallbackMetadata)
    expect(playing).toHaveBeenCalledOnce()
    expect(Peer.instance.getStats).not.toHaveBeenCalled()
    present(32, {} as VideoFrameCallbackMetadata)
    expect(playing).toHaveBeenCalledOnce()
    handle.cancel()
    present(48, {} as VideoFrameCallbackMetadata)
    expect(playing).toHaveBeenCalledOnce()
  })

  it("无 WebRTC 能力时明确返回空，不发送协商或接管请求", () => {
    vi.stubGlobal("RTCPeerConnection", undefined)
    mocks.request.mockReset()
    const result = watchEgoRtc(
      document.createElement("video"),
      7,
      "page",
      "view",
      "device-first",
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn()
    )
    expect(result).toBeNull()
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it("切页取消后迟到协商会关闭旧连接，不显示旧页也不交还 Agent", async () => {
    let finish: (result: unknown) => void = () => {}
    const channel = {
      readyState: "connecting",
      close: vi.fn(),
      send: vi.fn(),
      bufferedAmount: 0,
    }
    const remote = vi.fn()
    const close = vi.fn()
    class Peer extends EventTarget {
      iceGatheringState = "complete"
      localDescription = { type: "offer", sdp: "offer" }
      createDataChannel() {
        return channel
      }
      addTransceiver() {}
      async createOffer() {
        return this.localDescription
      }
      async setLocalDescription() {}
      setRemoteDescription = remote
      close = close
    }
    vi.stubGlobal("RTCPeerConnection", Peer)
    mocks.request.mockReset()
    mocks.request.mockImplementation((request: { method: string }) =>
      request.method === "rtcOffer"
        ? new Promise((resolve) => {
            finish = resolve
          })
        : Promise.resolve({ closed: true })
    )
    const playing = vi.fn()
    const fallback = vi.fn()
    const handle = watchEgoRtc(
      document.createElement("video"),
      7,
      "page",
      "view",
      "device-first",
      playing,
      vi.fn(),
      vi.fn(),
      fallback,
      vi.fn()
    )!
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledOnce())
    expect(handle.send(1, { kind: "text", text: "not-sent" })).toBeNull()
    handle.cancel()
    finish({
      id: "late-connection",
      answer: { type: "answer", sdp: "answer" },
      capture: "cdp-canvas",
    })
    await vi.waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith({
        method: "rtcClose",
        sessionId: 7,
        clientId: "device-first",
        id: "late-connection",
      })
    )
    expect(remote).not.toHaveBeenCalled()
    expect(playing).not.toHaveBeenCalled()
    expect(fallback).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })
})

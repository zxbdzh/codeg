import { afterEach, describe, expect, it, vi } from "vitest"
import { WebBrowserVideo } from "./web-browser-video"

afterEach(() => vi.unstubAllGlobals())

describe("Web browser video playback", () => {
  it("paces bursts across refreshes and releases dropped and stopped frames", () => {
    let callbacks!: VideoDecoderInit
    const decode = vi.fn()
    const close = vi.fn()
    const configure = vi.fn((config: VideoDecoderConfig) => {
      if (config.hardwareAcceleration === "prefer-hardware")
        throw new Error("VP8 hardware decoder unavailable")
    })
    vi.stubGlobal(
      "VideoDecoder",
      class {
        state = "configured"
        constructor(init: VideoDecoderInit) {
          callbacks = init
        }
        configure = configure
        decode = decode
        close = close
      }
    )
    vi.stubGlobal(
      "EncodedVideoChunk",
      class {
        constructor(readonly init: EncodedVideoChunkInit) {}
      }
    )
    let nextPaint!: FrameRequestCallback
    let requestId = 0
    const requestPaint = vi.fn((callback: FrameRequestCallback) => {
      nextPaint = callback
      return ++requestId
    })
    const cancelPaint = vi.fn()
    vi.stubGlobal("requestAnimationFrame", requestPaint)
    vi.stubGlobal("cancelAnimationFrame", cancelPaint)
    const drawImage = vi.fn()
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
    } as unknown as HTMLCanvasElement
    const painted = vi.fn()
    const acknowledged = vi.fn()
    const failure = vi.fn()
    const player = new WebBrowserVideo(canvas, painted, acknowledged, failure)
    player.start("vp8")
    expect(configure).toHaveBeenCalledWith({
      codec: "vp8",
      optimizeForLatency: true,
    })
    const packet = (timestamp: number) => {
      const bytes = new ArrayBuffer(17)
      const view = new DataView(bytes)
      view.setUint32(0, 0x43475631)
      view.setUint8(4, 1)
      view.setFloat64(5, timestamp)
      return bytes
    }
    player.append(packet(1000))
    expect(decode).toHaveBeenCalledOnce()
    expect(acknowledged).not.toHaveBeenCalled()
    const frame = (timestamp: number) =>
      ({
        timestamp,
        displayWidth: 1280,
        displayHeight: 720,
        close: vi.fn(),
      }) as unknown as VideoFrame
    const first = frame(1000)
    const second = frame(2000)
    const third = frame(3000)
    callbacks.output(first)
    player.append(packet(2000))
    callbacks.output(second)
    player.append(packet(3000))
    callbacks.output(third)
    expect(drawImage).not.toHaveBeenCalled()
    expect(requestPaint).toHaveBeenCalledOnce()
    expect(acknowledged).toHaveBeenCalledExactlyOnceWith(1000)
    expect(first.close).toHaveBeenCalledOnce()

    nextPaint(16)
    expect(drawImage).toHaveBeenCalledExactlyOnceWith(second, 0, 0)
    expect(painted).toHaveBeenCalledOnce()
    expect(acknowledged).toHaveBeenLastCalledWith(2000)
    expect(second.close).toHaveBeenCalledOnce()
    nextPaint(32)
    expect(drawImage).toHaveBeenLastCalledWith(third, 0, 0)
    expect(acknowledged).toHaveBeenLastCalledWith(3000)
    expect(third.close).toHaveBeenCalledOnce()

    const pending = frame(4000)
    player.append(packet(4000))
    callbacks.output(pending)
    player.stop()
    expect(cancelPaint).toHaveBeenCalledExactlyOnceWith(3)
    expect(acknowledged).toHaveBeenLastCalledWith(4000)
    expect(pending.close).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    const late = frame(5000)
    callbacks.output(late)
    expect(drawImage).toHaveBeenCalledTimes(2)
    expect(late.close).toHaveBeenCalledOnce()
    expect(() => player.append(new ArrayBuffer(3))).toThrow(/不完整/)
    expect(() => player.start("unknown")).toThrow(/格式/)
  })
})

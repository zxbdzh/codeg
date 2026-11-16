import { afterEach, describe, expect, it, vi } from "vitest"

const mocked = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("@/lib/transport", () => ({
  getServerBaseUrl: () => "http://test",
  isDesktop: () => false,
}))
vi.mock("@/lib/transport/web-auth", () => ({
  getCodegToken: () => "private-token",
  codegAuthHeaders: () => ({ Authorization: "Bearer private-token" }),
}))
vi.mock("./ego-api", () => ({ egoRequest: mocked.request }))

import {
  validatePixelPacket,
  watchEgoPixels,
  type EgoPixelPacket,
} from "./ego-pixel-stream"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  mocked.request.mockReset()
})

function packet(): EgoPixelPacket {
  return {
    kind: "pixel",
    streamId: "one",
    revision: "one",
    id: 1,
    baseId: 0,
    tabId: "page-a",
    width: 800,
    height: 600,
    cssWidth: 800,
    cssHeight: 600,
    atlasWidth: 800,
    atlasHeight: 600,
    data: "aW1hZ2U=",
    rectangles: [{ x: 0, y: 0, width: 800, height: 600, atlasY: 0 }],
    chooser: null,
    dialog: null,
  }
}

describe("独立无损页面的目标和画面基准", () => {
  it("首帧完整，后续必须依赖上次已绘制帧", () => {
    const first = packet()
    expect(() => validatePixelPacket(first, "page-a", null)).not.toThrow()
    expect(() =>
      validatePixelPacket({ ...first, id: 2, baseId: 1 }, "page-a", first)
    ).not.toThrow()
    expect(() =>
      validatePixelPacket({ ...first, id: 3, baseId: 2 }, "page-a", first)
    ).toThrow()
  })
  it("同网址不同目标、旧代次、其他设备流和不完整首帧均拒绝", () => {
    const first = packet()
    expect(() => validatePixelPacket(first, "page-b", null)).toThrow()
    expect(() =>
      validatePixelPacket(
        { ...first, revision: "old", id: 2, baseId: 1 },
        "page-a",
        first
      )
    ).toThrow()
    expect(() =>
      validatePixelPacket(
        { ...first, streamId: "other", id: 2, baseId: 1 },
        "page-a",
        first
      )
    ).toThrow()
    expect(() =>
      validatePixelPacket({ ...first, rectangles: [] }, "page-a", null)
    ).toThrow()
  })
  it("越界区域不进入 canvas", () => {
    const first = packet()
    expect(() =>
      validatePixelPacket(
        {
          ...first,
          rectangles: [{ x: 0, y: 0, width: 801, height: 600, atlasY: 0 }],
        },
        "page-a",
        null
      )
    ).toThrow()
  })

  it("切页取消后迟到解码不绘制、不确认也不重试或交还", async () => {
    let finishDecode: (bitmap: ImageBitmap) => void = () => {}
    const context = { drawImage: vi.fn() }
    const canvas = document.createElement("canvas")
    vi.spyOn(canvas, "getContext").mockReturnValue(
      context as unknown as CanvasRenderingContext2D
    )
    const bitmap = { width: 800, height: 600, close: vi.fn() }
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(
        () =>
          new Promise<ImageBitmap>((resolve) => {
            finishDecode = resolve
          })
      )
    )
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`${JSON.stringify(packet())}\n`)
        )
      },
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body })
    vi.stubGlobal("fetch", fetchMock)
    const fallback = vi.fn(),
      playing = vi.fn()
    const cancel = watchEgoPixels(
      canvas,
      7,
      "page-a",
      "device-first",
      vi.fn(),
      playing,
      fallback,
      vi.fn()
    )!
    await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledOnce())
    cancel()
    finishDecode(bitmap as unknown as ImageBitmap)
    await vi.waitFor(() => expect(bitmap.close).toHaveBeenCalledOnce())
    expect(context.drawImage).not.toHaveBeenCalled()
    expect(mocked.request).not.toHaveBeenCalled()
    expect(playing).not.toHaveBeenCalled()
    expect(fallback).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe("http://test/api/ego_stream")
  })
})

import { getServerBaseUrl, isDesktop } from "@/lib/transport"
import { codegAuthHeaders, getCodegToken } from "@/lib/transport/web-auth"
import { egoRequest, type EgoFrame } from "./ego-api"
import type { EgoVideoDiagnostics } from "./ego-video-stream"

export interface EgoPixelPacket {
  kind: "pixel"
  streamId: string
  revision: string
  id: number
  baseId: number
  tabId: string
  width: number
  height: number
  cssWidth: number
  cssHeight: number
  atlasWidth: number
  atlasHeight: number
  data: string
  rectangles: {
    x: number
    y: number
    width: number
    height: number
    atlasY: number
  }[]
  chooser: EgoFrame["chooser"]
  dialog: EgoFrame["dialog"]
}

export function validatePixelPacket(
  packet: EgoPixelPacket,
  tabId: string,
  previous: EgoPixelPacket | null
) {
  if (
    packet.kind !== "pixel" ||
    packet.tabId !== tabId ||
    typeof packet.streamId !== "string" ||
    typeof packet.revision !== "string" ||
    !Number.isSafeInteger(packet.id) ||
    packet.id <= 0 ||
    (previous != null && packet.id <= previous.id) ||
    ![packet.width, packet.height, packet.atlasWidth, packet.atlasHeight].every(
      Number.isSafeInteger
    ) ||
    !Number.isFinite(packet.cssWidth) ||
    !Number.isFinite(packet.cssHeight) ||
    packet.cssWidth <= 0 ||
    packet.cssHeight <= 0 ||
    packet.width <= 0 ||
    packet.height <= 0 ||
    packet.width > 4096 ||
    packet.height > 4096 ||
    packet.atlasWidth <= 0 ||
    packet.atlasHeight <= 0 ||
    packet.atlasWidth * packet.atlasHeight > 32 * 1024 * 1024 ||
    !Array.isArray(packet.rectangles) ||
    packet.rectangles.length > 4096 ||
    typeof packet.data !== "string"
  )
    throw new Error("无效的页面画面。")
  if (
    previous
      ? packet.revision !== previous.revision ||
        packet.streamId !== previous.streamId ||
        packet.baseId !== previous.id
      : packet.baseId !== 0
  )
    throw new Error("画面基准不一致，正在重新连接。")
  if (
    !previous &&
    !(
      packet.rectangles.length === 1 &&
      packet.rectangles[0].x === 0 &&
      packet.rectangles[0].y === 0 &&
      packet.rectangles[0].width === packet.width &&
      packet.rectangles[0].height === packet.height
    )
  )
    throw new Error("首帧必须是完整页面。")
  for (const rectangle of packet.rectangles) {
    if (
      !Object.values(rectangle).every(
        (value) => Number.isSafeInteger(value) && value >= 0
      ) ||
      !rectangle.width ||
      !rectangle.height ||
      rectangle.x + rectangle.width > packet.width ||
      rectangle.y + rectangle.height > packet.height ||
      rectangle.width > packet.atlasWidth ||
      rectangle.atlasY + rectangle.height > packet.atlasHeight
    )
      throw new Error("画面区域越界。")
  }
}

export function watchEgoPixels(
  canvas: HTMLCanvasElement,
  sessionId: number,
  tabId: string,
  clientId: string,
  onFrame: (frame: EgoFrame) => void,
  onPlaying: () => void,
  onFallback: (reason: string) => void,
  onDiagnostics: (details: EgoVideoDiagnostics) => void
): (() => void) | null {
  if (isDesktop() || typeof createImageBitmap !== "function") return null
  let stopped = false
  let generation = 0
  let controller: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let retries = 0
  const connect = async () => {
    const current = ++generation
    controller = new AbortController()
    const signal = controller.signal
    let previous: EgoPixelPacket | null = null
    let bytes = 0
    let frames = 0
    const start = performance.now()
    const valid = () => !stopped && !signal.aborted && current === generation
    try {
      const response = await fetch(`${getServerBaseUrl()}/api/ego_stream`, {
        method: "POST",
        headers: {
          ...codegAuthHeaders(getCodegToken()),
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionId, tabId, clientId, format: "pixels" }),
        signal,
        cache: "no-store",
      })
      if (!response.ok || !response.body) throw new Error("无损显示暂不可用。")
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let pending = ""
      const context = canvas.getContext("2d", { alpha: false })
      if (!context) throw new Error("当前设备无法绘制页面。")
      try {
        for (;;) {
          const result = await reader.read()
          if (!valid() || result.done) break
          bytes += result.value.byteLength
          pending += decoder.decode(result.value, { stream: true })
          if (pending.length > 48 * 1024 * 1024)
            throw new Error("画面数据过大。")
          let newline: number
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline)
            pending = pending.slice(newline + 1)
            if (!line.trim()) continue
            const packet = JSON.parse(line) as EgoPixelPacket
            validatePixelPacket(packet, tabId, previous)
            const image = await createImageBitmap(
              new Blob(
                [
                  Uint8Array.from(atob(packet.data), (character) =>
                    character.charCodeAt(0)
                  ),
                ],
                { type: "image/webp" }
              )
            )
            try {
              // 切页/断线后的旧解码结果不能写入新画布，也不能确认旧代次。
              if (!valid()) return
              if (
                image.width !== packet.atlasWidth ||
                image.height !== packet.atlasHeight
              )
                throw new Error("图像尺寸不一致。")
              if (
                canvas.width !== packet.width ||
                canvas.height !== packet.height
              ) {
                canvas.width = packet.width
                canvas.height = packet.height
              }
              for (const rectangle of packet.rectangles)
                context.drawImage(
                  image,
                  0,
                  rectangle.atlasY,
                  rectangle.width,
                  rectangle.height,
                  rectangle.x,
                  rectangle.y,
                  rectangle.width,
                  rectangle.height
                )
              previous = packet
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve())
              )
              if (!valid()) return
              onFrame({
                data: "",
                width: packet.cssWidth,
                height: packet.cssHeight,
                chooser: packet.chooser,
                dialog: packet.dialog,
              })
              onPlaying()
              retries = 0
              frames++
              onDiagnostics({
                stage: "无损页面显示",
                attempt: retries + 1,
                bytes,
                fps: (frames * 1000) / Math.max(1, performance.now() - start),
                bufferMs: 0,
                width: packet.width,
                height: packet.height,
              })
              const ack = await egoRequest<{ accepted: boolean }>({
                method: "pixelAck",
                sessionId,
                tabId,
                clientId,
                streamId: packet.streamId,
                revision: packet.revision,
                id: packet.id,
              })
              if (!ack.accepted) throw new Error("画面确认已过期。")
            } finally {
              image.close()
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
      if (valid()) throw new Error("页面显示已断开。")
    } catch (error) {
      if (!valid()) return
      controller?.abort()
      if (++retries < 3) timer = setTimeout(() => void connect(), 250)
      else
        onFallback(
          error instanceof Error ? error.message : "页面显示连接失败。"
        )
    }
  }
  void connect()
  return () => {
    stopped = true
    generation++
    controller?.abort()
    if (timer) clearTimeout(timer)
  }
}

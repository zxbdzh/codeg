import { getServerBaseUrl, isDesktop } from "@/lib/transport"
import { codegAuthHeaders, getCodegToken } from "@/lib/transport/web-auth"
import type { EgoFrame } from "./ego-api"

export function watchEgoFrames(
  sessionId: number,
  tabId: string,
  onFrame: (frame: EgoFrame) => void,
  onStopped: () => void
): (() => void) | null {
  if (isDesktop()) return null
  const controller = new AbortController()
  void (async () => {
    try {
      const response = await fetch(`${getServerBaseUrl()}/api/ego_stream`, {
        method: "POST",
        headers: {
          ...codegAuthHeaders(getCodegToken()),
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionId, tabId }),
        signal: controller.signal,
        cache: "no-store",
      })
      if (!response.ok || !response.body) throw new Error("stream_unavailable")
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let pending = ""
      try {
        for (;;) {
          const result = await reader.read()
          if (result.done) break
          pending += decoder.decode(result.value, { stream: true })
          // 服务器每行最多一帧；异常流不能无限占用客户端内存。
          if (pending.length > 8 * 1024 * 1024)
            throw new Error("frame_too_large")
          let newline: number
          let latest: EgoFrame | null = null
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline)
            pending = pending.slice(newline + 1)
            if (!line.trim()) continue
            const frame = JSON.parse(line) as EgoFrame
            if (
              typeof frame.data !== "string" ||
              !(frame.width > 0) ||
              !(frame.height > 0)
            ) {
              throw new Error("invalid_frame")
            }
            latest = frame
          }
          // 网络恢复会一次交付多帧，只解码最新画面，避免客户端重新播放过期滚动。
          if (latest && !controller.signal.aborted) onFrame(latest)
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
    } catch {
      // 旧服务或代理不支持流式响应时，调用方继续使用截图兼容通道。
    } finally {
      if (!controller.signal.aborted) onStopped()
    }
  })()
  return () => controller.abort()
}

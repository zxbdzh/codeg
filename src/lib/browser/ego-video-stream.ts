import { getServerBaseUrl, isDesktop } from "@/lib/transport"
import { codegAuthHeaders, getCodegToken } from "@/lib/transport/web-auth"

const videoCodec = 'video/mp4; codecs="avc1.42C02A"'

export interface EgoVideoDiagnostics {
  stage: string
  attempt: number
  bytes: number
  fps: number | null
  bufferMs: number
  width: number
  height: number
  reason?: string
  transport?: string
  roundTripMs?: number
}

export function egoVideoUnavailableReason(): string | null {
  if (isDesktop()) return "当前桌面内嵌环境未接通直连视频，请从 Codeg Web 访问"
  if (
    typeof MediaSource === "undefined" ||
    typeof MediaSource.isTypeSupported !== "function"
  )
    return "当前浏览器未提供 MediaSource 视频接口"
  if (!MediaSource.isTypeSupported(videoCodec))
    return "当前浏览器不支持此 H.264 视频解码规格"
  return null
}

export function watchEgoVideo(
  video: HTMLVideoElement,
  sessionId: number,
  tabId: string,
  onPlaying: () => void,
  onFallback: (reason?: string) => void,
  onDiagnostics?: (details: EgoVideoDiagnostics) => void
): (() => void) | null {
  const codec = videoCodec
  const hasFrameCallback = typeof video.requestVideoFrameCallback === "function"
  if (egoVideoUnavailableReason()) return null
  let stopped = false
  let controller: AbortController | null = null
  let objectUrl: string | null = null
  let frameCallback = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let attempts = 0
  let generation = 0
  const cleanup = () => {
    controller?.abort()
    video.cancelVideoFrameCallback?.(frameCallback)
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = null
  }
  const connect = async () => {
    const current = ++generation
    cleanup()
    const connectionController = new AbortController()
    controller = connectionController
    const signal = connectionController.signal
    let failure = "视频连接已中断"
    const startupTimeout = setTimeout(() => {
      failure = "视频启动超过 8 秒"
      connectionController.abort()
    }, 8000)
    const media = new MediaSource()
    objectUrl = URL.createObjectURL(media)
    video.src = objectUrl
    let watchdog: ReturnType<typeof setInterval> | undefined
    let lastFrame = performance.now()
    let receivedBytes = 0
    let frameCount = 0
    let reportedAt = performance.now()
    let reportedFrames = 0
    let bufferMs = 0
    let displayed = false
    const diagnostics = (stage: string, reason?: string) => {
      const now = performance.now()
      onDiagnostics?.({
        stage,
        attempt: attempts + 1,
        bytes: receivedBytes,
        fps: hasFrameCallback
          ? ((frameCount - reportedFrames) * 1000) /
            Math.max(1, now - reportedAt)
          : null,
        bufferMs,
        width: video.videoWidth,
        height: video.videoHeight,
        reason,
      })
      reportedAt = now
      reportedFrames = frameCount
    }
    diagnostics("正在连接")
    const presented = () => {
      if (stopped || current !== generation || video.readyState < 2) return
      lastFrame = performance.now()
      if (!displayed) {
        clearTimeout(startupTimeout)
        displayed = true
        attempts = 0
        onPlaying()
      }
    }
    const mediaError = () => {
      failure = `视频解码失败（${video.error?.code ?? "未知"}）`
      connectionController.abort()
    }
    video.addEventListener("error", mediaError)
    if (!hasFrameCallback) video.addEventListener("timeupdate", presented)
    try {
      await new Promise<void>((resolve, reject) => {
        media.addEventListener("sourceopen", () => resolve(), { once: true })
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          {
            once: true,
          }
        )
      })
      if (stopped || current !== generation) return
      const buffer = media.addSourceBuffer(codec)
      const response = await fetch(`${getServerBaseUrl()}/api/ego_stream`, {
        method: "POST",
        headers: {
          ...codegAuthHeaders(getCodegToken()),
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionId, tabId, format: "video" }),
        signal,
        cache: "no-store",
      })
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get("content-type")?.startsWith("video/mp4")
      )
        throw new Error(`视频服务不可用（HTTP ${response.status}）`)
      const observe = () => {
        if (!hasFrameCallback) return
        frameCallback = video.requestVideoFrameCallback(() => {
          if (stopped || current !== generation) return
          presented()
          frameCount += 1
          observe()
        })
      }
      observe()
      watchdog = setInterval(() => {
        diagnostics(displayed ? "正在播放" : "等待首帧")
        // 静止页面由服务端重复最新帧；没有实际呈现的新帧才算连接卡住。
        if (
          document.visibilityState !== "hidden" &&
          performance.now() - lastFrame > 6000
        ) {
          failure = "超过 6 秒没有呈现新画面"
          connectionController.abort()
        }
      }, 1000)
      const reader = response.body.getReader()
      let playing = false
      let lastAdjust = performance.now()
      const update = (operation: () => void) =>
        new Promise<void>((resolve, reject) => {
          const done = () => {
            buffer.removeEventListener("updateend", done)
            buffer.removeEventListener("error", failed)
            signal.removeEventListener("abort", failed)
            resolve()
          }
          const failed = () => {
            buffer.removeEventListener("updateend", done)
            buffer.removeEventListener("error", failed)
            signal.removeEventListener("abort", failed)
            reject(new Error("视频数据解码或追加失败"))
          }
          buffer.addEventListener("updateend", done, { once: true })
          buffer.addEventListener("error", failed, { once: true })
          signal.addEventListener("abort", failed, { once: true })
          try {
            operation()
          } catch {
            failed()
          }
        })
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done || stopped || current !== generation) break
          await update(() => buffer.appendBuffer(chunk.value))
          receivedBytes += chunk.value.byteLength
          if (buffer.buffered.length) {
            const end = buffer.buffered.end(buffer.buffered.length - 1)
            bufferMs = Math.max(0, end - video.currentTime) * 1000
            if (!playing && end > 0.1) {
              playing = true
              void video.play().catch(() => {
                failure = "浏览器拒绝播放视频"
                connectionController.abort()
              })
            }
            if (performance.now() - lastAdjust > 1000) {
              lastAdjust = performance.now()
              const behind = end - video.currentTime
              if (behind > 0.6) video.currentTime = Math.max(0, end - 0.15)
              video.playbackRate = behind > 0.25 ? 1.03 : 1
              if (
                video.currentTime > 20 &&
                buffer.buffered.start(0) < video.currentTime - 15
              )
                await update(() => buffer.remove(0, video.currentTime - 10))
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError")
        failure = error.message
      diagnostics("重连中", failure)
      // 没有安装编码器、旧服务或重连失败时回到原通道，不改变页面/人工归属。
    } finally {
      clearInterval(watchdog)
      clearTimeout(startupTimeout)
      video.removeEventListener("error", mediaError)
      video.removeEventListener("timeupdate", presented)
      if (!stopped && current === generation) {
        cleanup()
        if (++attempts < 3) retryTimer = setTimeout(() => void connect(), 250)
        else onFallback(failure)
      }
    }
  }
  void connect()
  return () => {
    stopped = true
    generation += 1
    clearTimeout(retryTimer)
    cleanup()
    video.removeAttribute("src")
    video.load()
  }
}

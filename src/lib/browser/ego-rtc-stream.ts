import { egoError, egoRequest, type EgoFrame, type EgoSession } from "./ego-api"
import { isDesktop } from "@/lib/transport"
import type { EgoVideoDiagnostics } from "./ego-video-stream"

export interface EgoRtcHandle {
  cancel: () => void
  send: (
    epoch: number,
    action: Record<string, unknown>
  ) => Promise<EgoSession> | null
}

export function watchEgoRtc(
  video: HTMLVideoElement,
  sessionId: number,
  tabId: string,
  viewId: string,
  clientId: string,
  onPlaying: () => void,
  onSession: (session: EgoSession) => void,
  onFrame: (frame: EgoFrame) => void,
  onFallback: (reason?: string) => void,
  onDiagnostics: (details: EgoVideoDiagnostics) => void
): EgoRtcHandle | null {
  if (isDesktop() || typeof RTCPeerConnection === "undefined") return null
  let stopped = false
  let generation = 0
  let peer: RTCPeerConnection | null = null
  let channel: RTCDataChannel | null = null
  let remoteId: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let startupTimer: ReturnType<typeof setTimeout> | null = null
  let frameCallback = 0
  let nextId = 0
  let retries = 0
  const pending = new Map<
    number,
    {
      resolve: (session: EgoSession) => void
      reject: (reason: unknown) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const closeRemote = (id: string) => {
    void egoRequest({ method: "rtcClose", sessionId, clientId, id }).catch(
      () => {}
    )
  }
  const cleanup = () => {
    if (startupTimer) clearTimeout(startupTimer)
    startupTimer = null
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
    video.cancelVideoFrameCallback?.(frameCallback)
    channel?.close()
    channel = null
    peer?.close()
    peer = null
    video.srcObject = null
    if (remoteId) closeRemote(remoteId)
    remoteId = null
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error("实时输入连接已中断；未自动重放，请先检查页面。"))
    }
    pending.clear()
  }
  const send = (epoch: number, action: Record<string, unknown>) => {
    const current = channel
    if (!current || current.readyState !== "open") return null
    // 积压时不可同时改用 HTTP 重发：前一个动作可能已经执行，必须显式失败。
    if (current.bufferedAmount > 512 * 1024)
      return Promise.reject<EgoSession>(
        new Error("实时输入暂时拥塞，请稍后重试。")
      )
    const id = ++nextId
    return new Promise<EgoSession>((resolve, reject) => {
      const expiry = setTimeout(() => {
        pending.delete(id)
        reject(new Error("操作结果超时，未自动重放；请检查真实页面。"))
      }, 10000)
      pending.set(id, { resolve, reject, timer: expiry })
      try {
        current.send(JSON.stringify({ id, kind: "human", epoch, action }))
      } catch (reason) {
        clearTimeout(expiry)
        pending.delete(id)
        reject(reason)
      }
    })
  }
  const connect = async () => {
    const current = ++generation
    cleanup()
    let failure = "WebRTC 连接中断"
    const connection = new RTCPeerConnection({ iceServers: [] })
    peer = connection
    const input = connection.createDataChannel("codeg-input", { ordered: true })
    channel = input
    let seenFrame = false
    let lastPacket = performance.now()
    let previousTime = performance.now()
    let capture = "兼容采集"
    let presentedFrames = 0
    let presentedBefore = 0
    let ended = false
    const valid = () => !stopped && current === generation
    const fail = (reason: string) => {
      if (!valid() || ended) return
      ended = true
      failure = reason
      cleanup()
      if (++retries < 3) timer = setTimeout(() => void connect(), 300)
      else onFallback(failure)
    }
    startupTimer = setTimeout(() => fail("WebRTC 协商超过 15 秒"), 15000)
    input.onmessage = (event) => {
      if (
        !valid() ||
        typeof event.data !== "string" ||
        event.data.length > 2 * 1024 * 1024
      )
        return
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (!message || typeof message !== "object" || Array.isArray(message))
        return
      lastPacket = performance.now()
      if (message.kind === "metadata") {
        if (message.width > 0 && message.height > 0)
          onFrame({
            data: "",
            width: message.width,
            height: message.height,
            chooser: null,
            dialog: null,
          })
        return
      }
      if (message.kind !== "result" || !Number.isSafeInteger(message.id)) return
      const entry = pending.get(message.id)
      if (!entry) {
        if (message.result?.control && message.result.sessionId === sessionId)
          onSession(message.result)
        return
      }
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error)
        entry.reject(new Error(message.error.message || "实时输入失败"))
      else if (
        message.result?.control &&
        message.result.sessionId === sessionId
      )
        entry.resolve(message.result)
      else entry.reject(new Error("实时输入返回了无效会话状态。"))
    }
    input.onopen = () => {
      if (!valid()) return
      input.send(JSON.stringify({ kind: "ping", id: ++nextId }))
    }
    input.onclose = () => fail("WebRTC 输入通道已断开")
    connection.ontrack = (event) => {
      if (!valid()) return
      video.srcObject = event.streams[0] ?? new MediaStream([event.track])
      if (typeof video.requestVideoFrameCallback === "function") {
        const observe = () => {
          frameCallback = video.requestVideoFrameCallback(() => {
            if (!valid() || ended) return
            presentedFrames++
            observe()
          })
        }
        observe()
      }
      void video.play().catch(() => fail("浏览器拒绝播放 WebRTC 视频"))
    }
    connection.onconnectionstatechange = () => {
      if (["failed", "closed"].includes(connection.connectionState))
        fail("WebRTC 无法连通；请检查网络或 TURN 配置")
    }
    const start = performance.now()
    try {
      connection.addTransceiver("video", { direction: "recvonly" })
      await connection.setLocalDescription(await connection.createOffer())
      await new Promise<void>((resolve) => {
        if (connection.iceGatheringState === "complete") return resolve()
        const timeout = setTimeout(resolve, 900)
        connection.addEventListener("icegatheringstatechange", () => {
          if (connection.iceGatheringState === "complete") {
            clearTimeout(timeout)
            resolve()
          }
        })
      })
      if (!valid()) return
      const result = await egoRequest<{
        id: string
        answer: RTCSessionDescriptionInit
        capture: string
      }>({
        method: "rtcOffer",
        sessionId,
        tabId,
        viewId,
        clientId,
        offer: {
          type: connection.localDescription!.type,
          sdp: connection.localDescription!.sdp,
        },
      })
      if (!valid()) {
        closeRemote(result.id)
        return
      }
      remoteId = result.id
      capture = result.capture === "native-tab" ? "原生标签采集" : "兼容采集"
      await connection.setRemoteDescription(result.answer)
      if (!valid()) return
      if (startupTimer) clearTimeout(startupTimer)
      startupTimer = null
      let checking = false
      heartbeat = setInterval(() => {
        if (!valid() || checking) return
        checking = true
        void (async () => {
          try {
            if (input.readyState === "open")
              input.send(JSON.stringify({ kind: "ping", id: ++nextId }))
            const stats = await connection.getStats()
            if (!valid()) return
            let bytes = 0
            let frames = 0
            let width = video.videoWidth
            let height = video.videoHeight
            let bufferMs = 0
            let transport: string | undefined
            let roundTripMs: number | undefined
            stats.forEach((report) => {
              if (
                report.type === "candidate-pair" &&
                report.state === "succeeded" &&
                report.nominated
              ) {
                const local = stats.get(report.localCandidateId)
                const remote = stats.get(report.remoteCandidateId)
                transport = `${local?.protocol || ""} · ${local?.candidateType || ""}/${remote?.candidateType || ""}`
                roundTripMs = (report.currentRoundTripTime ?? 0) * 1000
              }
              if (report.type !== "inbound-rtp" || report.kind !== "video")
                return
              bytes = report.bytesReceived ?? 0
              frames = report.framesDecoded ?? 0
              width = report.frameWidth || width
              height = report.frameHeight || height
              if (report.jitterBufferEmittedCount > 0)
                bufferMs =
                  (report.jitterBufferDelay / report.jitterBufferEmittedCount) *
                  1000
            })
            const now = performance.now()
            const fps =
              typeof video.requestVideoFrameCallback === "function"
                ? (Math.max(0, presentedFrames - presentedBefore) * 1000) /
                  Math.max(1, now - previousTime)
                : null
            presentedBefore = presentedFrames
            previousTime = now
            onDiagnostics({
              stage: `WebRTC · ${capture} · ${connection.connectionState}`,
              attempt: retries + 1,
              bytes,
              fps,
              bufferMs,
              width,
              height,
              transport,
              roundTripMs,
            })
            if (
              !seenFrame &&
              video.readyState >= 2 &&
              video.videoWidth > 0 &&
              frames > 0 &&
              (typeof video.requestVideoFrameCallback !== "function" ||
                presentedFrames > 0)
            ) {
              seenFrame = true
              retries = 0
              onPlaying()
            }
            if ((!seenFrame && now - start > 10000) || now - lastPacket > 9000)
              fail("WebRTC 等待画面超时，未自动改变页面或控制权")
          } catch (reason) {
            fail(egoError(reason))
          } finally {
            checking = false
          }
        })()
      }, 1000)
    } catch (reason) {
      if (startupTimer) clearTimeout(startupTimer)
      startupTimer = null
      fail(egoError(reason))
    }
  }
  void connect()
  return {
    send,
    cancel() {
      stopped = true
      generation++
      if (timer) clearTimeout(timer)
      cleanup()
    },
  }
}

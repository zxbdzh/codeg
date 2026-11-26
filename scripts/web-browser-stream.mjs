import { createServer, request as httpRequest } from "node:http"
import { pathToFileURL } from "node:url"
import path from "node:path"
import websocket from "next/dist/compiled/ws/index.js"
import { createTabVideo } from "./web-browser-video.mjs"

const { WebSocket, WebSocketServer } = websocket
const MAX_FRAMES = 4
const MAX_FRAME_BYTES = 384 * 1024

function parseMessage(raw) {
  try {
    const message = JSON.parse(String(raw))
    return typeof message?.type === "string" ? message : null
  } catch {
    return null
  }
}

export async function startBrowserStream({
  port = 3200,
  upstream,
  videoProfile,
  videoDataDir,
  stunUrl,
}) {
  const target = new URL(upstream)
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1")
    throw new Error("浏览器串流上游必须使用本机回环地址")
  if (stunUrl && !/^stun:[\w.-]+(?::\d{1,5})?$/.test(stunUrl))
    throw new Error("浏览器串流只接受配置的 STUN 地址")
  const targetUrl = (request) => {
    const endpoint = new URL(target)
    const query = request.url.indexOf("?")
    // 直接赋路径，避免把 // 开头的请求当作域名解析；上游始终固定在本机。
    endpoint.pathname = query < 0 ? request.url : request.url.slice(0, query)
    endpoint.search = query < 0 ? "" : request.url.slice(query)
    return endpoint
  }
  const server = createServer((request, response) => {
    const forwarded = httpRequest(
      targetUrl(request),
      {
        method: request.method,
        headers: { ...request.headers, host: target.host },
      },
      (received) => {
        response.writeHead(received.statusCode, received.headers)
        received.on("error", () => response.destroy())
        received.pipe(response)
      }
    )
    forwarded.on("error", () => {
      if (response.headersSent) response.destroy()
      else response.writeHead(502).end("Browser upstream unavailable")
    })
    request.on("aborted", () => forwarded.destroy())
    response.on("close", () => forwarded.destroy())
    request.pipe(forwarded)
  })
  const video = videoProfile
    ? createTabVideo({
        profile: videoProfile,
        dataDir: videoDataDir,
        endpoint: () => `ws://127.0.0.1:${server.address().port}`,
      })
    : null
  const sockets = new Set()
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    handleProtocols: (protocols) =>
      protocols.has("codeg-browser") ? "codeg-browser" : false,
  })
  server.on("upgrade", (request, socket, head) => {
    const capturePath = request.url.match(/^\/capture\/([a-f0-9]{64})$/)
    if (capturePath) {
      const capture = video?.accept(capturePath[1])
      if (
        !capture ||
        capture.socket ||
        !capture.active() ||
        request.headers.origin !== capture.origin ||
        request.headers["x-forwarded-for"] ||
        !["127.0.0.1", "::ffff:127.0.0.1"].includes(socket.remoteAddress)
      ) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
        return
      }
      wss.handleUpgrade(request, socket, head, (producer) => {
        capture.socket = producer
        const live = () => video.accept(capturePath[1]) === capture
        producer.on("message", (raw, binary) => {
          if (live()) capture.send(raw, binary, capture)
        })
        producer.on("error", () => {})
        producer.once("close", () => {
          if (live())
            capture.send(
              JSON.stringify({ type: "video-error" }),
              false,
              capture
            )
        })
      })
      return
    }
    const endpoint = targetUrl(request)
    endpoint.protocol = "ws:"
    const protocols = String(request.headers["sec-websocket-protocol"] || "")
      .split(",")
      .map((protocol) => protocol.trim())
      .filter(Boolean)
    // 原浏览器继续验证身份、来源和页面权限，也继续持有音频和 Agent 会话。
    let remote
    try {
      remote = new WebSocket(endpoint, protocols, {
        origin: request.headers.origin,
        headers: {
          cookie: request.headers.cookie || "",
          ...(request.headers.authorization
            ? { authorization: request.headers.authorization }
            : {}),
        },
        handshakeTimeout: 10000,
      })
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
      return
    }
    let client
    let rejected = false
    let controlled = false
    let sequence = 0
    let pending
    let outstandingBytes = 0
    let wantsVideo = false
    let wantsRtc = false
    let supportsVp8 = false
    let rtcSequence = 0
    let upstreamReady = false
    let videoActive = false
    let audioRequested = false
    let jpegId
    let capture
    let openingVideo
    let firstVideo
    let dimensions
    let tabId
    let videoTarget
    const videoFrames = new Set()
    const inFlight = new Map()
    const active = () =>
      client?.readyState === WebSocket.OPEN &&
      remote.readyState === WebSocket.OPEN
    const stopVideo = async () => {
      clearTimeout(firstVideo)
      videoActive = false
      videoFrames.clear()
      const previous = capture
      capture = null
      await video?.stop(previous)
    }
    const ackJpeg = () => {
      if (jpegId === undefined || !active()) return
      remote.send(JSON.stringify({ type: "frame-ack", id: jpegId }))
      jpegId = undefined
    }
    const stopMediaOnClient = (source) => {
      if (source?.rtcId !== undefined)
        client.send(JSON.stringify({ type: "rtc-stop", id: source.rtcId }))
      else if (videoActive) client.send(JSON.stringify({ type: "video-stop" }))
      if (videoActive && audioRequested)
        client.send(JSON.stringify({ type: "audio-stop" }))
    }
    const activateMedia = (source) => {
      clearTimeout(firstVideo)
      videoActive = true
      pending = undefined
      inFlight.clear()
      outstandingBytes = 0
      if (audioRequested && !source.audioOn) {
        source.audioOn = true
        source.socket?.send(JSON.stringify({ type: "audio", enabled: true }))
      }
    }
    const fallbackVideo = (reason) => {
      if (!wantsVideo) return
      if (reason)
        console.warn("Codeg video fallback:", reason.message || reason)
      const retryVp8 = wantsRtc && supportsVp8
      wantsRtc = false
      wantsVideo = retryVp8
      if (active()) stopMediaOnClient(capture)
      const stopped = stopVideo()
      if (!active()) return
      ackJpeg()
      void stopped.then(() => {
        if (retryVp8) startVideo()
        else if (audioRequested && active())
          remote.send(JSON.stringify({ type: "audio", enabled: true }))
      })
    }
    const resolveVideoTarget = async () => {
      // 先让原服务验证标签归属，再从该标签的受限 DevTools 取得 targetId。
      const encoded = protocols
        .find((protocol) => protocol.startsWith("codeg-token."))
        ?.slice(12)
      const authorization =
        request.headers.authorization ||
        (encoded
          ? `Bearer ${Buffer.from(encoded, "base64url").toString("utf8")}`
          : "")
      const entry = await fetch(
        new URL("/devtools-entry?tab=" + encodeURIComponent(tabId), target),
        {
          method: "POST",
          headers: {
            Authorization: authorization,
            ...(request.headers.origin
              ? { Origin: request.headers.origin }
              : {}),
          },
          signal: AbortSignal.timeout(5000),
        }
      )
      if (!entry.ok) throw new Error("视频标签认证失败")
      const entryUrl = new URL((await entry.json()).url)
      const cap = entryUrl.pathname.split("/").at(-1)
      if (!/^[a-f0-9]{64}$/.test(cap)) throw new Error("无效的视频标签凭据")
      const permission = await fetch(
        new URL("/devtools/enter/" + cap, target),
        { redirect: "manual", signal: AbortSignal.timeout(5000) }
      )
      if (permission.status !== 302) throw new Error("视频标签授权失败")
      const inspectorUrl = new URL("/devtools/socket/" + cap, target)
      inspectorUrl.protocol = "ws:"
      const inspector = new WebSocket(inspectorUrl, {
        origin: entryUrl.origin,
        headers: {
          Cookie: permission.headers.get("set-cookie")?.split(";")[0] || "",
        },
        handshakeTimeout: 5000,
      })
      let info
      try {
        info = await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("视频标签连接超时")),
            5000
          )
          inspector.once("open", () =>
            inspector.send(
              JSON.stringify({ id: 1, method: "Target.getTargetInfo" })
            )
          )
          inspector.on("message", (raw) => {
            try {
              const response = JSON.parse(String(raw))
              if (response.id !== 1) return
              clearTimeout(timeout)
              const info = response.result?.targetInfo
              if (info?.type !== "page" || typeof info.targetId !== "string")
                reject(new Error("视频标签身份校验失败"))
              else resolve(info)
            } catch (error) {
              clearTimeout(timeout)
              reject(error)
            }
          })
          inspector.once("error", (error) => {
            clearTimeout(timeout)
            reject(error)
          })
        })
      } finally {
        inspector.close()
      }
      return info.targetId
    }
    const startVideo = () => {
      if (
        !wantsVideo ||
        !upstreamReady ||
        !dimensions ||
        openingVideo ||
        !active() ||
        (capture?.width === dimensions.width &&
          capture?.height === dimensions.height)
      )
        return
      const viewport = dimensions
      const rtcId = wantsRtc ? ++rtcSequence : undefined
      openingVideo = (async () => {
        if (capture) {
          // 标签采集不能扩展已绑定的尺寸；只重建该标签的采集，网页和连接保持不变。
          stopMediaOnClient(capture)
          await stopVideo()
          ackJpeg()
        }
        videoTarget ??= await resolveVideoTarget()
        if (!active() || !wantsVideo) return
        const started = await video.start(
          videoTarget,
          (raw, binary, source) => {
            if (!active() || !wantsVideo || (capture && capture !== source))
              return
            capture ??= source
            if (binary) {
              if (
                rtcId !== undefined ||
                !videoActive ||
                raw.length < 14 ||
                raw.readUInt32BE() !== 0x43475631
              )
                return
              const timestamp = raw.readDoubleBE(5)
              videoFrames.add(timestamp)
              client.send(raw, { binary: true })
            } else {
              const message = parseMessage(raw)
              if (!message) return
              if (message.type === "rtc-offer" || message.type === "rtc-ice") {
                if (rtcId !== undefined)
                  client.send(
                    JSON.stringify({
                      ...message,
                      id: rtcId,
                      ...(message.type === "rtc-offer"
                        ? { ...viewport, stunUrl }
                        : {}),
                    })
                  )
                return
              }
              if (message.type === "rtc-input") {
                // 保留原服务对当前连接、标签归属及每种输入的校验。
                if (
                  rtcId !== undefined &&
                  videoActive &&
                  ["pointer", "text", "key"].includes(message.input?.type)
                )
                  remote.send(JSON.stringify(message.input))
                return
              }
              if (message.type === "video-start") activateMedia(source)
              if (message.type === "video-error") {
                fallbackVideo(message.message || "视频采集连接已关闭")
                return
              }
              client.send(raw, { binary: false })
            }
          },
          () => active() && wantsVideo && (rtcId === undefined || wantsRtc),
          { ...viewport, rtcId, stunUrl }
        )
        if (!started || !active() || !wantsVideo) return
        capture = started
        if (!videoActive)
          firstVideo = setTimeout(
            () => fallbackVideo("未收到视频首帧"),
            rtcId === undefined ? 4000 : 6000
          )
      })()
        .catch(fallbackVideo)
        .finally(() => {
          openingVideo = null
          // 视频采集调整窗口会覆盖可见区域，成功或回退后都恢复当前页面尺寸。
          if (active() && dimensions)
            remote.send(JSON.stringify({ type: "resize", ...dimensions }))
          startVideo()
        })
    }
    const flush = () => {
      if (
        !pending ||
        client?.readyState !== WebSocket.OPEN ||
        inFlight.size >= MAX_FRAMES
      )
        return
      const estimate = (pending.data.length * 3) / 4 + 4
      // 限制帧数与字节数，慢链路只保存最新候选画面，不重放旧帧。
      if (inFlight.size && outstandingBytes + estimate > MAX_FRAME_BYTES) return
      const jpeg = Buffer.from(pending.data, "base64")
      pending = undefined
      sequence = (sequence + 1) >>> 0 || 1
      const packet = Buffer.allocUnsafe(4 + jpeg.length)
      packet.writeUInt32BE(sequence)
      jpeg.copy(packet, 4)
      inFlight.set(sequence, packet.length)
      outstandingBytes += packet.length
      // 四帧有界流水线覆盖公网往返；JPEG 直接传二进制，省去 Base64 开销。
      client.send(packet)
    }
    remote.on("message", (raw, binary) => {
      if (client?.readyState !== WebSocket.OPEN) return
      if (controlled && !binary) {
        const message = parseMessage(raw)
        if (
          !message ||
          (message.type === "frame" && typeof message.data !== "string")
        ) {
          client.close(1011, "Invalid browser message")
          return
        }
        if (message.type === "frame") {
          jpegId = typeof message.id === "number" ? message.id : undefined
          // 视频稳定后不给旧 JPEG 流返信用，回退时取新的画面。
          if (videoActive) return
          ackJpeg()
          pending = message
          flush()
          return
        }
        if (message.type === "state") {
          upstreamReady = true
          startVideo()
        }
      }
      client.send(raw, { binary })
    })
    remote.on("open", () => {
      if (socket.destroyed) {
        remote.close()
        return
      }
      wss.handleUpgrade(request, socket, head, (viewer) => {
        client = viewer
        client.on("message", (raw, binary) => {
          if (endpoint.pathname === "/socket" && !binary) {
            const message = parseMessage(raw)
            if (!message) {
              client.close(1007)
              return
            }
            if (message.type === "open") {
              if (tabId !== undefined || typeof message.tabId !== "string") {
                client.close(1008, "One browser tab per connection")
                return
              }
              tabId = message.tabId
              controlled =
                message.frameProtocol === "jpeg-v2" &&
                message.flowControl === true
              supportsVp8 = message.videoProtocol === "vp8-v1"
              wantsRtc =
                controlled && Boolean(video) && message.rtcProtocol === "rtc-v1"
              wantsVideo =
                controlled && Boolean(video) && (wantsRtc || supportsVp8)
              inFlight.clear()
              outstandingBytes = 0
              pending = undefined
              if (controlled) {
                if (remote.readyState === WebSocket.OPEN)
                  remote.send(
                    JSON.stringify({ ...message, flowControl: wantsVideo })
                  )
                return
              }
            }
            if (message.type.startsWith("rtc-")) {
              if (!wantsRtc || !capture || message.id !== capture.rtcId) return
              if (message.type === "rtc-ready") {
                activateMedia(capture)
                client.send(
                  JSON.stringify({ type: "rtc-active", id: capture.rtcId })
                )
              } else if (message.type === "rtc-fallback") {
                fallbackVideo("WebRTC 连接不可用")
              } else if (
                message.type === "rtc-answer" &&
                !capture.rtcAnswered &&
                typeof message.sdp === "string" &&
                message.sdp.length <= 64 * 1024
              ) {
                capture.rtcAnswered = true
                capture.socket?.send(
                  JSON.stringify({ type: message.type, sdp: message.sdp })
                )
              } else if (
                message.type === "rtc-ice" &&
                (capture.iceCount ?? 0) < 64 &&
                typeof message.candidate?.candidate === "string" &&
                message.candidate.candidate.length <= 1024
              ) {
                capture.iceCount = (capture.iceCount ?? 0) + 1
                capture.socket?.send(
                  JSON.stringify({
                    type: message.type,
                    candidate: {
                      candidate: message.candidate.candidate,
                      sdpMid:
                        typeof message.candidate.sdpMid === "string"
                          ? message.candidate.sdpMid.slice(0, 32)
                          : null,
                      sdpMLineIndex: Number.isInteger(
                        message.candidate.sdpMLineIndex
                      )
                        ? message.candidate.sdpMLineIndex
                        : null,
                    },
                  })
                )
              }
              return
            }
            if (message.type === "video-ack") {
              if (videoFrames.delete(message.timestamp))
                capture?.socket?.send(
                  JSON.stringify({ type: "credit", count: 1 })
                )
              return
            }
            if (message.type === "video-fallback") {
              fallbackVideo()
              return
            }
            if (message.type === "audio") {
              audioRequested = Boolean(message.enabled)
              if (wantsVideo) {
                if (videoActive && capture) {
                  capture.audioOn = audioRequested
                  capture.socket?.send(JSON.stringify(message))
                }
                return
              }
            }
            if (wantsVideo && message.type === "resize") {
              const width = Math.min(
                1920,
                Math.max(320, Math.round(Number(message.width)))
              )
              const height = Math.min(
                1440,
                Math.max(240, Math.round(Number(message.height)))
              )
              if (Number.isFinite(width) && Number.isFinite(height)) {
                dimensions = { width, height, mobile: Boolean(message.mobile) }
                queueMicrotask(startVideo)
              }
            }
            if (controlled && message.type === "frame-ack") {
              const bytes = inFlight.get(message.id)
              if (bytes) {
                inFlight.delete(message.id)
                outstandingBytes -= bytes
                flush()
              }
              return
            }
          }
          if (remote.readyState === WebSocket.OPEN) remote.send(raw, { binary })
        })
        client.on("close", () => {
          void stopVideo()
          remote.close()
        })
        client.on("error", () => remote.close())
      })
    })
    remote.on("unexpected-response", (_request, response) => {
      rejected = true
      response.resume()
      socket.end(
        `HTTP/1.1 ${response.statusCode} Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
      )
      remote.terminate()
    })
    remote.on("close", (code) => {
      void stopVideo()
      pending = undefined
      inFlight.clear()
      if (client)
        client.close(
          code === 4001 || code === 1000 ? code : 1012,
          "Browser upstream closed"
        )
      else if (!rejected) socket.destroy()
    })
    remote.on("error", () => {
      if (client) client.close(1011, "Browser upstream unavailable")
      else if (!rejected) socket.destroy()
    })
    socket.on("error", () => remote.close())
    socket.on("close", () => remote.close())
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolve)
  })
  return {
    server,
    stop() {
      void video?.close()
      wss.close()
      server.close()
      // HTTP 升级期间还未加入 WebSocket 客户端集合，关闭时也要释放这些连接。
      for (const socket of sockets) socket.destroy()
    },
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const stream = await startBrowserStream({
    port: Number(process.env.CODEG_BROWSER_STREAM_PORT || 3200),
    upstream:
      process.env.CODEG_BROWSER_STREAM_UPSTREAM || "http://127.0.0.1:3199",
    videoProfile:
      process.env.CODEG_BROWSER_VIDEO_PROFILE ||
      path.join(process.env.LOCALAPPDATA, "CodegWebBrowser", "profile"),
    videoDataDir:
      process.env.CODEG_BROWSER_VIDEO_DATA_DIR ||
      path.join(process.env.LOCALAPPDATA, "CodegWebBrowserVideo"),
    stunUrl: process.env.CODEG_BROWSER_STUN_URL,
  })
  console.log(
    `Codeg browser stream ready on 127.0.0.1:${stream.server.address().port}`
  )
  process.on("SIGINT", () => stream.stop())
  process.on("SIGTERM", () => stream.stop())
}

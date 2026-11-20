import { createServer, request as httpRequest } from "node:http"
import { pathToFileURL } from "node:url"
import path from "node:path"
import websocket from "next/dist/compiled/ws/index.js"

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

export async function startBrowserStream({ port = 3200, upstream }) {
  const target = new URL(upstream)
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1")
    throw new Error("浏览器串流上游必须使用本机回环地址")
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
    const inFlight = new Map()
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
          pending = message
          flush()
          return
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
              controlled =
                message.frameProtocol === "jpeg-v2" &&
                message.flowControl === true
              inFlight.clear()
              outstandingBytes = 0
              pending = undefined
              if (controlled) {
                if (remote.readyState === WebSocket.OPEN)
                  remote.send(
                    JSON.stringify({ ...message, flowControl: false })
                  )
                return
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
        client.on("close", () => remote.close())
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
  })
  console.log(
    `Codeg browser stream ready on 127.0.0.1:${stream.server.address().port}`
  )
  process.on("SIGINT", () => stream.stop())
  process.on("SIGTERM", () => stream.stop())
}

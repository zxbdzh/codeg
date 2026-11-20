import { randomBytes } from "node:crypto"
import websocket from "next/dist/compiled/ws/index.js"
const { WebSocket, WebSocketServer } = websocket

export function createDevtools({
  browser,
  publicOrigin,
  sessions,
  allowedOrigin,
}) {
  const entries = new Map()
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
  })
  function mint(session) {
    for (const [cap] of entries) if (!valid(cap)) entries.delete(cap)
    const cap = randomBytes(32).toString("hex")
    entries.set(cap, { session, expires: Date.now() + 3600000 })
    return { url: `${publicOrigin}/devtools/enter/${cap}` }
  }
  function valid(cap) {
    const grant = entries.get(cap)
    if (
      !grant ||
      grant.expires < Date.now() ||
      sessions.get(grant.session.key) !== grant.session
    )
      return null
    return grant
  }
  function cookie(request) {
    return String(request.headers.cookie || "")
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith("codeg_inspector="))
      ?.slice(16)
  }
  async function handle(request, response) {
    const url = new URL(request.url, publicOrigin)
    if (!url.pathname.startsWith("/devtools/")) return false
    const entry = url.pathname.match(/^\/devtools\/enter\/([a-f0-9]{64})$/)
    if (entry) {
      if (!valid(entry[1])) {
        response.writeHead(403).end()
        return true
      }
      response
        .writeHead(302, {
          "Set-Cookie": `codeg_inspector=${entry[1]}; Path=/devtools/; HttpOnly; SameSite=Strict${publicOrigin.startsWith("https:") ? "; Secure" : ""}`,
          Location: `/devtools/inspector.html?${publicOrigin.startsWith("https:") ? "wss" : "ws"}=${new URL(publicOrigin).host}/devtools/socket/${entry[1]}`,
        })
        .end()
      return true
    }
    if (!valid(cookie(request))) {
      response.writeHead(403).end()
      return true
    }
    if (
      request.method !== "GET" ||
      !/^\/devtools\/[a-zA-Z0-9_./-]+$/.test(url.pathname) ||
      url.pathname.includes("..")
    ) {
      response.writeHead(404).end()
      return true
    }
    const connection = await browser()
    const endpoint = new URL(connection.endpoint)
    endpoint.protocol = "http:"
    endpoint.pathname = url.pathname
    endpoint.search = url.search
    const upstream = await fetch(endpoint, {
      signal: AbortSignal.timeout(15000),
    })
    response.writeHead(upstream.status, {
      "Content-Type":
        upstream.headers.get("content-type") || "application/octet-stream",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `frame-ancestors 'self' ${allowedOrigin}`,
    })
    response.end(Buffer.from(await upstream.arrayBuffer()))
    return true
  }
  async function upgrade(request, socket, head) {
    const match = new URL(request.url, publicOrigin).pathname.match(
      /^\/devtools\/socket\/([a-f0-9]{64})$/
    )
    if (!match) return false
    const grant = valid(match[1])
    if (
      !grant ||
      cookie(request) !== match[1] ||
      request.headers.origin !== publicOrigin
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n")
      return true
    }
    const connection = await browser()
    const endpoint = new URL(connection.endpoint)
    endpoint.pathname = `/devtools/page/${grant.session.targetId}`
    wss.handleUpgrade(request, socket, head, (client) => {
      const upstream = new WebSocket(endpoint)
      const pending = []
      upstream.on("open", () =>
        pending.splice(0).forEach((message) => upstream.send(message))
      )
      client.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw))
          const [domain, method] = String(message.method).split(".")
          const pageDomains = [
            "Accessibility",
            "Animation",
            "Audits",
            "Console",
            "CSS",
            "Debugger",
            "DOM",
            "DOMDebugger",
            "DOMSnapshot",
            "Emulation",
            "Fetch",
            "Inspector",
            "IO",
            "LayerTree",
            "Log",
            "Network",
            "Overlay",
            "Page",
            "Performance",
            "Profiler",
            "Runtime",
            "Schema",
            "Security",
            "Target",
          ]
          // 页面 CDP 也能调用整份资料的 Cookie API；只放行当前页面的调试能力。
          const forbidden =
            !pageDomains.includes(domain) ||
            (domain === "Target" &&
              !["Target.setAutoAttach", "Target.getTargetInfo"].includes(
                message.method
              )) ||
            (domain === "Network" &&
              [
                "clearBrowserCookies",
                "clearBrowserCache",
                "setCookie",
                "setCookies",
                "deleteCookies",
              ].includes(method)) ||
            (domain === "Network" &&
              method === "getCookies" &&
              message.params?.urls?.some(
                (url) =>
                  new URL(url).origin !== new URL(grant.session.url).origin
              )) ||
            (domain === "Page" && method === "setDownloadBehavior") ||
            (domain === "Security" &&
              method !== "enable" &&
              method !== "disable") ||
            (message.params?.targetId &&
              message.params.targetId !== grant.session.targetId)
          if (!valid(match[1]) || forbidden) {
            client.send(
              JSON.stringify({
                id: message.id,
                error: {
                  code: -32000,
                  message: "This inspector is restricted to its Codeg tab",
                },
              })
            )
            return
          }
          if (message.method === "Network.getAllCookies") {
            message.method = "Network.getCookies"
            message.params = { urls: [grant.session.url] }
          }
          const forwarded = JSON.stringify(message)
          if (upstream.readyState === WebSocket.OPEN) upstream.send(forwarded)
          else if (pending.length < 100) pending.push(forwarded)
        } catch {
          client.close(1003)
        }
      })
      upstream.on("message", (raw) => {
        if (!valid(match[1])) {
          client.close(1008)
          return
        }
        if (client.readyState === WebSocket.OPEN) client.send(String(raw))
      })
      upstream.on("error", () => client.close(1011))
      upstream.on("close", () => client.close())
      client.on("close", () => upstream.close())
      client.on("error", () => upstream.close())
    })
    return true
  }
  function stop() {
    entries.clear()
    for (const client of wss.clients) client.terminate()
    wss.close()
  }
  return { mint, handle, upgrade, stop }
}

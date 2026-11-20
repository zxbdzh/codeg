import { createServer } from "node:http"
import { createRequire } from "node:module"
import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { createReadStream } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { browserAgentSource } from "./web-browser-assets.mjs"
import { createBrowserAgent } from "./web-browser-agent.mjs"
import { createTabAudio } from "./web-browser-audio.mjs"
import { createDevtools } from "./web-browser-devtools.mjs"

const require = createRequire(import.meta.url)
const { WebSocketServer } = require("next/dist/compiled/ws")

export function websiteUrl(value) {
  const parsed = new URL(value)
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    throw new Error("仅支持不带账号密码的 HTTP / HTTPS 地址")
  return parsed.href
}

export class CdpConnection {
  constructor(url) {
    this.endpoint = url
    this.pending = new Map()
    this.sequence = 0
    this.listeners = new Set()
    this.socket = new WebSocket(url)
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("浏览器启动超时")),
        10000
      )
      this.socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout)
          resolve()
        },
        { once: true }
      )
      this.socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout)
          reject(new Error("浏览器连接失败"))
        },
        { once: true }
      )
    })
    this.socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data)
      const pending = this.pending.get(message.id)
      if (pending) {
        this.pending.delete(message.id)
        clearTimeout(pending.timeout)
        if (message.error)
          pending.reject(
            new Error(`${pending.method}: ${message.error.message}`)
          )
        else pending.resolve(message.result)
      } else for (const listener of this.listeners) listener(message)
    })
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout)
        pending.reject(new Error("浏览器连接已断开"))
      }
      this.pending.clear()
    })
  }

  async call(method, params = {}, sessionId) {
    await this.ready
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时`))
      }, 20000)
      this.pending.set(id, { resolve, reject, timeout, method })
      try {
        this.socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          })
        )
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(error)
      }
    })
  }
}

export async function startBrowserService(options = {}) {
  const port = options.port ?? Number(process.env.CODEG_BROWSER_PORT || 3195)
  const dataDir =
    options.dataDir ??
    process.env.CODEG_BROWSER_DATA_DIR ??
    path.join(process.env.LOCALAPPDATA || process.cwd(), "CodegWebBrowser")
  const authUrl =
    options.authUrl ??
    process.env.CODEG_BROWSER_AUTH_URL ??
    "http://127.0.0.1:3080/api/health"
  const allowedOrigin =
    options.origin ?? process.env.CODEG_BROWSER_ORIGIN ?? "https://codeg.odn.cc"
  const executable =
    options.executable ??
    process.env.CODEG_BROWSER_EXECUTABLE ??
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  const existingProfile =
    options.existingProfile ?? process.env.CODEG_BROWSER_EXISTING_PROFILE
  const publicOrigin =
    options.publicOrigin ??
    process.env.CODEG_BROWSER_PUBLIC_ORIGIN ??
    "https://codeg-ego.odn.cc"
  const sessions = new Map()
  const opening = new Map()
  const downloads = new Map()
  let browserPromise
  let browserProcess
  let shuttingDown = false
  await mkdir(dataDir, { recursive: true })
  const audio = createTabAudio({ browser, pageCall, send, dataDir })
  const devtools = createDevtools({
    browser,
    publicOrigin,
    sessions,
    allowedOrigin,
  })
  const agent = createBrowserAgent({
    sessions,
    pageCall,
    send,
    createSession,
    closeSession,
    source: browserAgentSource,
    websiteUrl,
  })

  async function browser() {
    if (shuttingDown && !browserPromise) throw new Error("浏览器服务已关闭")
    if (!browserPromise)
      browserPromise = (async () => {
        if (existingProfile) {
          const active = (
            await readFile(
              path.join(existingProfile, "DevToolsActivePort"),
              "utf8"
            )
          )
            .trim()
            .split(/\r?\n/)
          const connection = new CdpConnection(
            `ws://127.0.0.1:${active[0]}${active[1]}`
          )
          await connection.ready
          installDownloadEvents(connection)
          return connection
        }
        const profile = path.join(dataDir, "profile")
        await mkdir(profile, { recursive: true })
        browserProcess = spawn(
          executable,
          [
            "--headless=new",
            "--remote-debugging-port=0",
            "--remote-debugging-address=127.0.0.1",
            `--user-data-dir=${profile}`,
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-timer-throttling",
            "about:blank",
          ],
          { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }
        )
        const endpoint = await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () =>
              reject(new Error("浏览器启动超时，请检查执行文件和独立配置目录")),
            15000
          )
          browserProcess.once("error", (error) => {
            clearTimeout(timeout)
            reject(error)
          })
          browserProcess.stderr.on("data", (chunk) => {
            const match = String(chunk).match(
              /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/
            )
            if (match) {
              clearTimeout(timeout)
              resolve(match[1])
            }
          })
          browserProcess.once("exit", () => {
            clearTimeout(timeout)
            reject(new Error("浏览器进程已退出"))
          })
        })
        const connection = new CdpConnection(endpoint)
        await connection.ready
        await mkdir(path.join(dataDir, "downloads"), { recursive: true })
        await connection.call("Browser.setDownloadBehavior", {
          behavior: "allowAndName",
          downloadPath: path.join(dataDir, "downloads"),
          eventsEnabled: true,
        })
        installDownloadEvents(connection)
        browserProcess.once("exit", () => {
          browserPromise = null
          for (const session of sessions.values()) {
            send(session, {
              type: "error",
              message: "浏览器进程已退出，请重新连接",
            })
            session.socket?.close(1011)
          }
          sessions.clear()
        })
        return connection
      })().catch((error) => {
        browserPromise = null
        throw error
      })
    return browserPromise
  }

  function installDownloadEvents(connection) {
    connection.listeners.add((message) => {
      if (message.method === "Browser.downloadWillBegin") {
        const session = [...sessions.values()].find(
          (item) => item.frameId === message.params.frameId
        )
        if (session)
          downloads.set(message.params.guid, {
            session,
            name: path.basename(message.params.suggestedFilename),
            complete: false,
          })
      }
      if (message.method === "Browser.downloadProgress") {
        const download = downloads.get(message.params.guid)
        if (download && message.params.state === "completed") {
          download.complete = true
          send(download.session, {
            type: "download",
            id: message.params.guid,
            name: download.name,
          })
        }
      }
    })
  }

  function send(session, message) {
    if (
      session.socket?.readyState === 1 &&
      (session.socket.bufferedAmount < 4 * 1024 * 1024 ||
        // 回执已限制只有一帧在途，不能再丢帧后等待永远不会到达的回执。
        (session.flowControl && message.type === "frame"))
    )
      session.socket.send(JSON.stringify(message))
  }

  function sendFrame(session, frame) {
    if (session.socket?.readyState !== 1) return
    if (session.flowControl) {
      // 公网链路只允许一帧在途；等待显示时，用最新画面覆盖待发帧。
      if (session.frameInFlight) {
        session.pendingFrame = frame
        return
      }
      session.frameInFlight = ++session.frameSequence
      send(session, { ...frame, id: session.frameInFlight })
    } else send(session, frame)
  }

  async function pageCall(session, method, params = {}) {
    return (await browser()).call(method, params, session.cdpId)
  }

  async function state(session) {
    const history = await pageCall(session, "Page.getNavigationHistory")
    const current = history.entries[history.currentIndex]
    session.title = current?.title || ""
    send(session, {
      type: "state",
      url: current?.url || session.url,
      title: current?.title || "",
      back: history.currentIndex > 0,
      forward: history.currentIndex < history.entries.length - 1,
      grant: session.grant?.level || "none",
    })
  }

  async function createSession(key, url) {
    if (shuttingDown) throw new Error("浏览器服务正在关闭")
    if (sessions.size >= 16)
      throw new Error("浏览器标签已达 16 个，请先关闭不用的标签")
    const connection = await browser()
    // 可复用资料里的登录态，但不能按网址认领、关闭用户原有的标签。
    const { targetId } = await connection.call("Target.createTarget", {
      url: "about:blank",
      background: true,
    })
    const { sessionId: cdpId } = await connection.call(
      "Target.attachToTarget",
      { targetId, flatten: true }
    )
    const session = {
      key,
      tabId: key.slice(65),
      targetId,
      cdpId,
      url,
      socket: null,
      touched: Date.now(),
      width: 1280,
      height: 800,
      epoch: 0,
      grant: null,
      console: [],
      contexts: new Map(),
      frameSequence: 0,
      frameInFlight: 0,
      pendingFrame: null,
    }
    sessions.set(key, session)
    const listener = (message) => {
      if (message.sessionId !== cdpId) return
      if (message.method === "Page.screencastFrame") {
        void pageCall(session, "Page.screencastFrameAck", {
          sessionId: message.params.sessionId,
        }).catch(() => {})
        sendFrame(session, {
          type: "frame",
          data: message.params.data,
          width: message.params.metadata.deviceWidth,
          height: message.params.metadata.deviceHeight,
        })
      }
      if (
        message.method === "Page.frameNavigated" &&
        !message.params.frame.parentId
      ) {
        session.frameId = message.params.frame.id
        session.url = message.params.frame.url
        session.epoch++
        session.console = []
        session.snapshot = null
        session.pendingEval?.resolve(false)
        if (
          session.grant &&
          session.grant.origin !== new URL(session.url).origin
        ) {
          session.grant = null
          session.pendingEval?.resolve(false)
        }
        void pageCall(session, "Page.setInterceptFileChooserDialog", {
          enabled: true,
        }).catch(() => {})
        void state(session).catch(() => {})
      }
      if (
        message.method === "Page.loadEventFired" ||
        message.method === "Page.navigatedWithinDocument"
      ) {
        if (message.method === "Page.navigatedWithinDocument") {
          session.epoch++
          session.console = []
          session.snapshot = null
          session.pendingEval?.resolve(false)
        }
        void state(session).catch(() => {})
      }
      if (message.method === "Runtime.executionContextCreated") {
        const context = message.params.context
        session.contexts.set(context.id, context)
      }
      if (message.method === "Runtime.executionContextDestroyed")
        session.contexts.delete(message.params.executionContextId)
      if (message.method === "Runtime.executionContextsCleared")
        session.contexts.clear()
      if (message.method === "Runtime.consoleAPICalled") {
        const context = session.contexts.get(message.params.executionContextId)
        // 共享只涵盖当前主页面；授权前和其他来源的日志不进入可读取缓存。
        if (
          !session.grant ||
          context?.origin !== session.grant.origin ||
          context?.auxData?.frameId !== session.frameId
        )
          return
        session.console.push({
          level: message.params.type,
          text: message.params.args
            .map((item) => item.value ?? item.description ?? "")
            .join(" ")
            .slice(0, 8000),
          timestamp: message.params.timestamp,
        })
        if (session.console.length > 200) session.console.shift()
      }
      if (message.method === "Page.javascriptDialogOpening")
        send(session, {
          ...message.params,
          type: "dialog",
          dialogType: message.params.type,
        })
      if (message.method === "Page.fileChooserOpened") {
        session.fileNode = message.params.backendNodeId
        send(session, {
          type: "upload",
          multiple: message.params.mode === "selectMultiple",
        })
      }
      if (message.method === "Page.windowOpen")
        send(session, { type: "popup", url: message.params.url })
    }
    session.listener = listener
    connection.listeners.add(listener)
    await pageCall(session, "Page.enable", {
      enableFileChooserOpenedEvent: true,
    })
    await pageCall(session, "Runtime.enable")
    await pageCall(session, "Page.addScriptToEvaluateOnNewDocument", {
      source: browserAgentSource,
      worldName: "codeg-web-agent",
    })
    await pageCall(session, "Page.setInterceptFileChooserDialog", {
      enabled: true,
    })
    await pageCall(session, "Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await pageCall(session, "Page.navigate", { url })
    return session
  }

  async function closeSession(session) {
    session.grant = null
    session.epoch++
    session.console = []
    session.snapshot = null
    session.pendingEval?.resolve(false)
    if (session.audio) await audio.stop(session)
    const connection = await browser()
    await connection.call("Target.closeTarget", { targetId: session.targetId })
    connection.listeners.delete(session.listener)
    sessions.delete(session.key)
    session.socket?.close(1000)
  }

  async function authenticate(request) {
    const encoded = String(request.headers["sec-websocket-protocol"] || "")
      .split(",")
      .map((item) => item.trim())
      .find((item) => item.startsWith("codeg-token."))
      ?.slice(12)
    const token =
      request.headers.authorization?.replace(/^Bearer /, "") ||
      (encoded ? Buffer.from(encoded, "base64url").toString("utf8") : "")
    if (!token || token.length > 4096) throw new Error("请先登录 Codeg")
    // 只由现有 Codeg 验证身份；不创建第二套公网密码，也不向网页目标发送 Token。
    const response = await fetch(authUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    })
    if (!response.ok) throw new Error("Codeg 登录已失效，请重新登录")
    return createHash("sha256").update(token).digest("hex")
  }

  async function bodyOf(request) {
    const chunks = []
    let length = 0
    for await (const chunk of request) {
      length += chunk.length
      if (length > 24 * 1024 * 1024) throw new Error("单次上传不能超过 16 MB")
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  }

  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store")
    response.setHeader("X-Content-Type-Options", "nosniff")
    try {
      if (await devtools.handle(request, response)) return
    } catch {
      response.writeHead(502).end("Inspector connection failed")
      return
    }
    if (request.headers.origin && request.headers.origin !== allowedOrigin) {
      response.writeHead(403).end()
      return
    }
    response.setHeader("Access-Control-Allow-Origin", allowedOrigin)
    response.setHeader(
      "Access-Control-Allow-Headers",
      ["authorization", "content-type", "x-requested-with"].join(",")
    )
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
      return
    }
    try {
      const owner = await authenticate(request)
      const location = new URL(request.url, "http://localhost")
      const session = sessions.get(
        `${owner}:${location.searchParams.get("tab")}`
      )
      if (location.pathname === "/health") {
        response.writeHead(200).end('{"available":true}')
        return
      }
      if (location.pathname === "/mcp" && request.method === "POST") {
        const result = await agent(owner, await bodyOf(request))
        response
          .writeHead(result ? 200 : 202, { "Content-Type": "application/json" })
          .end(result ? JSON.stringify(result) : "")
        return
      }
      if (!session) {
        response.writeHead(404).end()
        return
      }
      if (location.pathname === "/close" && request.method === "POST") {
        await closeSession(session)
        response.writeHead(200).end('{"ok":true}')
        return
      }
      if (
        location.pathname === "/devtools-entry" &&
        request.method === "POST"
      ) {
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify(devtools.mint(session)))
        return
      }
      if (location.pathname === "/upload" && request.method === "POST") {
        if (!session.fileNode) throw new Error("请先点击网站的上传按钮")
        const input = await bodyOf(request)
        if (
          !Array.isArray(input.files) ||
          !input.files.length ||
          input.files.length > 10
        )
          throw new Error("上传文件数量无效")
        const files = []
        let total = 0
        const directory = path.join(
          dataDir,
          "uploads",
          randomBytes(12).toString("hex")
        )
        await mkdir(directory, { recursive: true })
        for (const file of input.files) {
          const buffer = Buffer.from(String(file.data), "base64")
          total += buffer.length
          if (total > 16 * 1024 * 1024)
            throw new Error("单次上传不能超过 16 MB")
          const name = path
            .basename(String(file.name))
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
          if (!name || name === "." || name === "..")
            throw new Error("无效的文件名")
          const filename = path.join(directory, `${files.length}-${name}`)
          await writeFile(filename, buffer)
          files.push(filename)
        }
        await pageCall(session, "DOM.setFileInputFiles", {
          backendNodeId: session.fileNode,
          files,
        })
        session.fileNode = null
        response.writeHead(200).end('{"ok":true}')
      } else if (
        location.pathname === "/download" &&
        request.method === "GET"
      ) {
        const id = location.searchParams.get("id")
        const download = downloads.get(id)
        if (!download?.complete || download.session !== session) {
          response.writeHead(404).end()
          return
        }
        response.setHeader("Content-Type", "application/octet-stream")
        response.setHeader(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(download.name)}`
        )
        const stream = createReadStream(path.join(dataDir, "downloads", id))
        stream.on("error", () => response.destroy())
        stream.pipe(response)
      } else response.writeHead(404).end()
    } catch (error) {
      response
        .writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: error.message }))
    }
  })

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    handleProtocols: () => "codeg-browser",
  })
  server.on("upgrade", async (request, socket, head) => {
    try {
      if (await devtools.upgrade(request, socket, head)) return
      if (
        request.headers.origin !== allowedOrigin ||
        new URL(request.url, "http://localhost").pathname !== "/socket"
      )
        throw new Error("Forbidden")
      const owner = await authenticate(request)
      wss.handleUpgrade(request, socket, head, (client) =>
        wss.emit("connection", client, owner)
      )
    } catch {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
    }
  })

  wss.on("connection", (socket, owner) => {
    let session
    let queue = Promise.resolve()
    socket.on("message", (raw) => {
      // 网页弹窗会阻塞触发它的输入命令，确认不能排在该输入之后等待。
      try {
        const immediate = JSON.parse(String(raw))
        if (immediate.type === "dialog" && session?.socket === socket) {
          void pageCall(session, "Page.handleJavaScriptDialog", {
            accept: Boolean(immediate.accept),
            promptText: String(immediate.text || "").slice(0, 10000),
          }).catch((error) =>
            send(session, { type: "error", message: error.message })
          )
          return
        }
        if (immediate.type === "frame-ack" && session?.socket === socket) {
          // 帧回执不能排在导航、音频初始化等耗时命令后面。
          if (
            session.flowControl &&
            session.frameInFlight &&
            immediate.id === session.frameInFlight
          ) {
            session.frameInFlight = 0
            const pending = session.pendingFrame
            session.pendingFrame = null
            if (pending) sendFrame(session, pending)
          }
          return
        }
      } catch {}
      queue = queue
        .then(async () => {
          if (shuttingDown) throw new Error("浏览器服务正在关闭")
          const message = JSON.parse(String(raw))
          if (message.type === "open") {
            if (!/^[\w:-]{1,160}$/.test(message.tabId))
              throw new Error("无效的标签标识")
            const url = websiteUrl(message.url)
            const key = `${owner}:${message.tabId}`
            if (!sessions.has(key)) {
              if (!opening.has(key))
                opening.set(
                  key,
                  createSession(key, url).finally(() => opening.delete(key))
                )
              await opening.get(key)
            }
            session = sessions.get(key)
            session.touched = Date.now()
            if (session.socket && session.socket !== socket)
              session.socket.close(4001, "Control moved")
            session.socket = socket
            session.flowControl = message.flowControl === true
            session.frameInFlight = 0
            session.pendingFrame = null
            await (
              await browser()
            ).call("Target.activateTarget", { targetId: session.targetId })
            if (message.navigate && session.url !== url)
              await pageCall(session, "Page.navigate", { url })
            await pageCall(session, "Page.startScreencast", {
              format: "jpeg",
              quality: 75,
              maxWidth: 1920,
              maxHeight: 1440,
              everyNthFrame: 1,
            })
            const capture = await pageCall(session, "Page.captureScreenshot", {
              format: "jpeg",
              quality: 75,
            })
            sendFrame(session, {
              type: "frame",
              data: capture.data,
              width: session.width,
              height: session.height,
            })
            await state(session)
            return
          }
          if (!session || session.socket !== socket)
            throw new Error("请先连接浏览器标签")
          session.touched = Date.now()
          if (message.type === "navigate") {
            const result = await pageCall(session, "Page.navigate", {
              url: websiteUrl(message.url),
            })
            if (result.errorText)
              throw new Error(`页面加载失败：${result.errorText}`)
          } else if (message.type === "history") {
            const history = await pageCall(session, "Page.getNavigationHistory")
            const entry =
              history.entries[
                history.currentIndex + (message.direction === "back" ? -1 : 1)
              ]
            if (entry)
              await pageCall(session, "Page.navigateToHistoryEntry", {
                entryId: entry.id,
              })
          } else if (message.type === "reload")
            await pageCall(session, "Page.reload")
          else if (message.type === "stop")
            await pageCall(session, "Page.stopLoading")
          else if (message.type === "share") {
            if (!["none", "read", "control"].includes(message.level))
              throw new Error("无效的共享权限")
            const frame = (await pageCall(session, "Page.getFrameTree"))
              .frameTree.frame
            session.grant =
              message.level === "none"
                ? null
                : { level: message.level, origin: new URL(frame.url).origin }
            session.console = []
            session.snapshot = null
            session.pendingEval?.resolve(false)
            await state(session)
          } else if (message.type === "eval-answer") {
            if (session.pendingEval?.requestId === message.requestId)
              session.pendingEval.resolve(message.approved === true)
          } else if (message.type === "audio") {
            if (message.enabled) await audio.start(session)
            else await audio.stop(session)
          } else if (message.type === "resize") {
            const width = Math.min(
              1920,
              Math.max(320, Math.round(Number(message.width)))
            )
            const height = Math.min(
              1440,
              Math.max(240, Math.round(Number(message.height)))
            )
            if (!Number.isFinite(width) || !Number.isFinite(height))
              throw new Error("无效的页面尺寸")
            session.width = width
            session.height = height
            await pageCall(session, "Emulation.setDeviceMetricsOverride", {
              width,
              height,
              deviceScaleFactor: 1,
              mobile: Boolean(message.mobile),
            })
          } else if (message.type === "pointer") {
            if (
              ![
                "mousePressed",
                "mouseReleased",
                "mouseMoved",
                "mouseWheel",
              ].includes(message.event)
            )
              throw new Error("无效的指针事件")
            const x = Math.min(session.width, Math.max(0, Number(message.x)))
            const y = Math.min(session.height, Math.max(0, Number(message.y)))
            if (!Number.isFinite(x) || !Number.isFinite(y))
              throw new Error("无效的指针坐标")
            const params = {
              type: message.event,
              x,
              y,
              button: ["left", "middle", "right"].includes(message.button)
                ? message.button
                : "none",
              buttons: Number(message.buttons) & 7,
              modifiers: Number(message.modifiers) & 15,
            }
            if (message.event === "mouseWheel") {
              params.deltaX = Math.max(
                -3000,
                Math.min(3000, Number(message.deltaX) || 0)
              )
              params.deltaY = Math.max(
                -3000,
                Math.min(3000, Number(message.deltaY) || 0)
              )
            } else if (message.event !== "mouseMoved")
              params.clickCount = message.count === 2 ? 2 : 1
            await pageCall(session, "Input.dispatchMouseEvent", params)
          } else if (message.type === "text") {
            if (
              typeof message.text !== "string" ||
              message.text.length > 100000
            )
              throw new Error("输入文字过长")
            await pageCall(session, "Input.insertText", { text: message.text })
          } else if (message.type === "key") {
            if (
              !["keyDown", "keyUp"].includes(message.event) ||
              typeof message.key !== "string" ||
              message.key.length > 40
            )
              throw new Error("无效的键盘事件")
            await pageCall(session, "Input.dispatchKeyEvent", {
              type: message.event,
              key: message.key,
              code: String(message.code).slice(0, 40),
              windowsVirtualKeyCode: Number(message.keyCode) & 255,
              modifiers: Number(message.modifiers) & 15,
              ...(message.event === "keyDown" && message.key === "Enter"
                ? { text: "\r", unmodifiedText: "\r" }
                : {}),
              ...(Array.isArray(message.commands)
                ? {
                    commands: message.commands.filter((item) =>
                      [
                        "selectAll",
                        "copy",
                        "cut",
                        "paste",
                        "undo",
                        "redo",
                      ].includes(item)
                    ),
                  }
                : {}),
            })
          } else if (message.type === "dialog")
            await pageCall(session, "Page.handleJavaScriptDialog", {
              accept: Boolean(message.accept),
              promptText: String(message.text || "").slice(0, 10000),
            })
          else if (message.type === "close") {
            await closeSession(session)
          }
        })
        .catch((error) => {
          if (socket.readyState === 1)
            socket.send(
              JSON.stringify({ type: "error", message: error.message })
            )
        })
    })
    socket.on("close", () => {
      if (session?.socket === socket) {
        session.pendingEval?.resolve(false)
        if (session.audio) void audio.stop(session).catch(() => {})
        session.socket = null
        session.frameInFlight = 0
        session.pendingFrame = null
        session.touched = Date.now()
        void pageCall(session, "Page.stopScreencast").catch(() => {})
      }
    })
    socket.on("error", () => {})
  })

  const cleanup = setInterval(() => {
    for (const session of sessions.values())
      if (!session.socket && Date.now() - session.touched > 60 * 60 * 1000) {
        void closeSession(session).catch(() => {})
      }
  }, 60000)
  cleanup.unref()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolve)
  })
  async function stop() {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(cleanup)
    devtools.stop()
    for (const client of wss.clients) client.close(1001)
    wss.close()
    server.close()
    if (browserPromise)
      try {
        const connection = await browserPromise
        if (existingProfile) {
          for (const session of [...sessions.values()])
            await closeSession(session)
        } else await connection.call("Browser.close")
        connection.socket.close()
      } catch {}
  }
  return { server, stop, dataDir }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const service = await startBrowserService()
  console.log(
    `Codeg online browser ready on 127.0.0.1:${service.server.address().port}`
  )
  process.on("SIGINT", () => void service.stop())
  process.on("SIGTERM", () => void service.stop())
}

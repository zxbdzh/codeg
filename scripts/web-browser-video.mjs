import { createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { CdpConnection } from "./web-browser-cdp.mjs"
import { videoExtensionFiles } from "./web-browser-assets.mjs"

export function createTabVideo({ profile, dataDir, endpoint }) {
  let connection
  let extensionPromise
  let queue = Promise.resolve()
  const captures = new Map()
  const capabilities = new Map()
  async function browser() {
    if (!connection) {
      const active = (
        await readFile(path.join(profile, "DevToolsActivePort"), "utf8")
      )
        .trim()
        .split(/\r?\n/)
      const current = new CdpConnection(
        `ws://127.0.0.1:${active[0]}${active[1]}`
      )
      current.socket.addEventListener("close", () => {
        if (connection !== current) return
        connection = null
        extensionPromise = null
      })
      connection = current
      await current.ready
    }
    return connection
  }
  async function extension() {
    if (!extensionPromise)
      extensionPromise = (async () => {
        const link = await browser()
        const version = createHash("sha256")
          .update(JSON.stringify(videoExtensionFiles))
          .digest("hex")
          .slice(0, 12)
        const directory = path.join(dataDir, `video-extension-${version}`)
        await mkdir(directory, { recursive: true })
        for (const [name, contents] of Object.entries(videoExtensionFiles))
          await writeFile(path.join(directory, name), contents)
        const loaded = await link.call("Extensions.loadUnpacked", {
          path: directory,
        })
        const { targetId } = await link.call("Target.createTarget", {
          url: "about:blank",
          background: true,
        })
        const { sessionId } = await link.call("Target.attachToTarget", {
          targetId,
          flatten: true,
        })
        try {
          await link.call("ServiceWorker.enable", {}, sessionId)
          await link.call(
            "ServiceWorker.startWorker",
            { scopeURL: `chrome-extension://${loaded.id}/` },
            sessionId
          )
        } finally {
          await link.call("Target.closeTarget", { targetId }).catch(() => {})
        }
        let workerId
        for (let attempt = 0; attempt < 50 && !workerId; attempt++) {
          workerId = (await link.call("Target.getTargets")).targetInfos.find(
            (item) => item.url === `chrome-extension://${loaded.id}/worker.js`
          )?.targetId
          if (!workerId)
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
        if (!workerId) throw new Error("视频扩展未启动")
        const worker = (
          await link.call("Target.attachToTarget", {
            targetId: workerId,
            flatten: true,
          })
        ).sessionId
        let listening = false
        for (let attempt = 0; attempt < 50 && !listening; attempt++) {
          const state = await link.call(
            "Runtime.evaluate",
            {
              expression: "globalThis.__codegVideoReady === true",
              returnByValue: true,
            },
            worker
          )
          listening = state.result.value === true
          if (!listening)
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
        if (!listening) throw new Error("视频扩展没有就绪")
        const ready = await link.call(
          "Runtime.evaluate",
          {
            expression: `chrome.offscreen.hasDocument().then(async exists=>{if(!exists)await chrome.offscreen.createDocument({url:"offscreen.html",reasons:["USER_MEDIA"],justification:"Stream only authenticated Codeg browser tabs"});return true})`,
            awaitPromise: true,
            returnByValue: true,
          },
          worker
        )
        if (ready.exceptionDetails)
          throw new Error(
            ready.exceptionDetails.exception?.description ||
              "视频扩展初始化失败"
          )
        const offscreen = (
          await link.call("Target.getTargets", { filter: [{ exclude: false }] })
        ).targetInfos.find(
          (item) =>
            item.url === `chrome-extension://${loaded.id}/offscreen.html`
        )
        if (!offscreen) throw new Error("视频采集页面未启动")
        const offscreenSession = (
          await link.call("Target.attachToTarget", {
            targetId: offscreen.targetId,
            flatten: true,
          })
        ).sessionId
        return { id: loaded.id, worker, offscreenSession }
      })().catch((error) => {
        extensionPromise = null
        throw error
      })
    return extensionPromise
  }
  async function start(
    targetId,
    send,
    isActive,
    { width, height, rtcId, stunUrl }
  ) {
    let tentative
    const operation = queue.then(async () => {
      const link = await browser()
      const loaded = await extension()
      if (!isActive()) return null
      // 由服务端认证后的 DevTools targetId 定位页面，不接受客户端指定任意标签。
      await stop(captures.get(targetId))
      const cap = randomBytes(32).toString("hex")
      const capture = {
        targetId,
        width,
        height,
        rtcId,
        cap,
        send,
        active: isActive,
        origin: `chrome-extension://${loaded.id}`,
        socket: null,
      }
      tentative = capture
      capabilities.set(cap, capture)
      captures.set(targetId, capture)
      const tabId = (
        await link.call(
          "Runtime.evaluate",
          {
            expression: `chrome.debugger.getTargets().then(targets=>targets.find(target=>target.id===${JSON.stringify(
              targetId
            )})?.tabId)`,
            returnByValue: true,
            awaitPromise: true,
          },
          loaded.worker
        )
      ).result.value
      if (!Number.isInteger(tabId))
        throw new Error("无法确认当前视频标签的唯一身份")
      capture.tabId = tabId
      // 独立窗口让视频像素与页面坐标对齐；重连时复用只有该标签的窗口。
      const isolated = await link.call(
        "Runtime.evaluate",
        {
          expression: `(async()=>{const tab=await chrome.tabs.get(${tabId});const tabs=await chrome.tabs.query({windowId:tab.windowId});if(tabs.length!==1)await chrome.windows.create({tabId:tab.id,focused:false,width:${width},height:${height + 100}});globalThis.__codegVideoLast=null;return true})()`,
          awaitPromise: true,
          returnByValue: true,
        },
        loaded.worker
      )
      if (isolated.exceptionDetails) throw new Error("无法创建隔离的视频窗口")
      const { windowId } = await link.call("Browser.getWindowForTarget", {
        targetId,
      })
      const tabTargets = (
        await link.call("Target.getTargets", {
          filter: [{ type: "tab", exclude: false }],
        })
      ).targetInfos
      const sameWindow = await Promise.all(
        tabTargets.map(async (target) => {
          const window = await link
            .call("Browser.getWindowForTarget", { targetId: target.targetId })
            .catch(() => null)
          return window?.windowId === windowId ? target.targetId : null
        })
      )
      const matching = sameWindow.filter(Boolean)
      if (matching.length !== 1 || !isActive())
        throw new Error("无法确认隔离窗口中的唯一视频标签")
      await link.call("Browser.setContentsSize", {
        windowId,
        width,
        height,
      })
      await link.call("Target.activateTarget", { targetId })
      const prepared = await link.call(
        "Runtime.evaluate",
        {
          expression: `globalThis.__codegPrepareVideo(${JSON.stringify(
            tabId
          )},${JSON.stringify({
            endpoint: endpoint() + "/capture/" + cap,
            width,
            height,
            rtc: rtcId !== undefined,
            stunUrl,
          })})`,
        },
        loaded.offscreenSession
      )
      if (prepared.exceptionDetails) throw new Error("视频采集准备失败")
      await link.call("Extensions.triggerAction", {
        id: loaded.id,
        targetId: matching[0],
      })
      let status
      for (let attempt = 0; attempt < 100; attempt++) {
        status = (
          await link.call(
            "Runtime.evaluate",
            {
              expression: "globalThis.__codegVideoLast",
              returnByValue: true,
            },
            loaded.worker
          )
        ).result.value
        if (status?.tabId === tabId && !status.pending) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      if (status?.tabId !== tabId || status.error || status.pending)
        throw new Error(status?.error || "视频采集启动超时")
      if (!isActive()) {
        await stop(capture)
        return null
      }
      return capture
    })
    const guarded = operation.catch(async (error) => {
      await stop(tentative)
      throw error
    })
    queue = guarded.catch(() => {})
    return guarded
  }
  async function stop(capture) {
    if (!capture || !capabilities.delete(capture.cap)) return
    if (captures.get(capture.targetId) === capture)
      captures.delete(capture.targetId)
    capture.socket?.close()
    if (capture.tabId != null)
      try {
        const loaded = await extension()
        await (
          await browser()
        ).call(
          "Runtime.evaluate",
          {
            expression: `globalThis.__codegStopVideo(${capture.tabId},${JSON.stringify(
              endpoint() + "/capture/" + capture.cap
            )})`,
          },
          loaded.offscreenSession
        )
      } catch {}
  }
  return {
    start,
    stop,
    accept(cap) {
      return capabilities.get(cap)
    },
    async close() {
      for (const capture of captures.values()) await stop(capture)
      connection?.socket.close()
    },
  }
}

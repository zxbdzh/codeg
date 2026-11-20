import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { audioExtensionFiles } from "./web-browser-assets.mjs"
import { createHash } from "node:crypto"

export function createTabAudio({ browser, pageCall, send, dataDir }) {
  let extension
  let offscreenSession
  const streams = new Map()
  let queue = Promise.resolve()

  async function start(session) {
    const connection = await browser()
    if (!extension) {
      const version = createHash("sha256")
        .update(JSON.stringify(audioExtensionFiles))
        .digest("hex")
        .slice(0, 12)
      const directory = path.join(dataDir, `audio-extension-${version}`)
      await mkdir(directory, { recursive: true })
      for (const [name, contents] of Object.entries(audioExtensionFiles))
        await writeFile(path.join(directory, name), contents)
      extension = await connection.call("Extensions.loadUnpacked", {
        path: directory,
      })
    }
    await connection.call("Target.activateTarget", {
      targetId: session.targetId,
    })
    const tabs = (
      await connection.call("Target.getTargets", {
        filter: [{ type: "tab", exclude: false }],
      })
    ).targetInfos
    const target = tabs.find(
      (item) => item.embedderData?.tabActive && item.url === session.url
    )
    if (!target) throw new Error("无法确认当前页面的音频来源，请刷新后重试")
    // CDP 的扩展动作不保证唤醒休眠的 MV3 worker，先明确启动再等待其监听器。
    await pageCall(session, "ServiceWorker.enable")
    await pageCall(session, "ServiceWorker.startWorker", {
      scopeURL: `chrome-extension://${extension.id}/`,
    })
    let ready = false
    for (let attempt = 0; attempt < 40 && !ready; attempt++) {
      const worker = (
        await connection.call("Target.getTargets", {
          filter: [{ exclude: false }],
        })
      ).targetInfos.find(
        (item) => item.url === `chrome-extension://${extension.id}/worker.js`
      )
      if (worker) {
        const link = await connection.call("Target.attachToTarget", {
          targetId: worker.targetId,
          flatten: true,
        })
        const result = await connection.call(
          "Runtime.evaluate",
          {
            expression: "globalThis.__codegAudioReady === true",
            returnByValue: true,
          },
          link.sessionId
        )
        ready = result.result.value === true
        await connection.call("Target.detachFromTarget", {
          sessionId: link.sessionId,
        })
      }
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error("音频扩展尚未就绪")
    // 点击“播放声音”才触发扩展动作，采集范围只限这个真实标签页。
    await connection.call("Extensions.triggerAction", {
      id: extension.id,
      targetId: target.targetId,
    })
    let worker
    let offscreen
    for (let attempt = 0; attempt < 100; attempt++) {
      const targets = (
        await connection.call("Target.getTargets", {
          filter: [{ exclude: false }],
        })
      ).targetInfos
      worker = targets.find(
        (item) => item.url === `chrome-extension://${extension.id}/worker.js`
      )
      offscreen = targets.find(
        (item) =>
          item.url === `chrome-extension://${extension.id}/offscreen.html`
      )
      if (worker && offscreen) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!worker || !offscreen) throw new Error("标签页音频采集未启动")
    const workerLink = await connection.call("Target.attachToTarget", {
      targetId: worker.targetId,
      flatten: true,
    })
    let capture
    try {
      for (let attempt = 0; attempt < 30; attempt++) {
        const result = await connection.call(
          "Runtime.evaluate",
          { expression: "globalThis.__codegAudioLast", returnByValue: true },
          workerLink.sessionId
        )
        capture = result.result.value
        if (capture && !capture.pending) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    } finally {
      await connection.call("Target.detachFromTarget", {
        sessionId: workerLink.sessionId,
      })
    }
    if (!capture || capture.error || capture.pending)
      throw new Error(capture?.error || "音频采集超时")
    streams.set(capture.tabId, session)
    session.audioTabId = capture.tabId
    if (!offscreenSession) {
      offscreenSession = (
        await connection.call("Target.attachToTarget", {
          targetId: offscreen.targetId,
          flatten: true,
        })
      ).sessionId
      await connection.call("Runtime.enable", {}, offscreenSession)
      await connection.call(
        "Runtime.addBinding",
        { name: "__codegAudio" },
        offscreenSession
      )
      connection.listeners.add((message) => {
        if (
          message.sessionId !== offscreenSession ||
          message.method !== "Runtime.bindingCalled" ||
          message.params.name !== "__codegAudio"
        )
          return
        const packet = JSON.parse(message.params.payload)
        const targetSession = streams.get(packet.tabId)
        if (targetSession?.audio)
          send(targetSession, { type: "audio", data: packet.data })
      })
    }
    session.audio = true
    send(session, { type: "audio-start", mime: "audio/webm;codecs=opus" })
    await connection.call(
      "Runtime.evaluate",
      { expression: "__codegFlushAudio()" },
      offscreenSession
    )
    await pageCall(session, "Runtime.evaluate", {
      expression:
        "document.querySelectorAll('audio,video').forEach(item=>{item.muted=false})",
    })
  }

  async function stop(session) {
    session.audio = false
    streams.delete(session.audioTabId)
    if (offscreenSession && session.audioTabId != null)
      await (await browser())
        .call(
          "Runtime.evaluate",
          { expression: `__codegStopAudio(${session.audioTabId})` },
          offscreenSession
        )
        .catch(() => {})
    send(session, { type: "audio-stop" })
  }
  return {
    start(session) {
      const next = queue.then(() => start(session))
      queue = next.catch(() => {})
      return next
    },
    stop(session) {
      // 停止也进入同一队列，防止未完成的启动在停止返回后重新开启采集。
      const next = queue.then(() => stop(session))
      queue = next.catch(() => {})
      return next
    },
  }
}

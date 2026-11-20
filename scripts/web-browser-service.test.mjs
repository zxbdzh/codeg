import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { spawnSync } from "node:child_process"

const { CdpConnection, startBrowserService, websiteUrl } = await import(
  process.env.CODEG_TEST_BROWSER_MODULE ||
    new URL("./web-browser-service.mjs", import.meta.url).href
)

test("website addresses retain HTTPS and reject executable URLs", () => {
  assert.equal(
    websiteUrl("https://example.com/a?q=1#anchor"),
    "https://example.com/a?q=1#anchor"
  )
  for (const value of [
    "javascript:alert(1)",
    "file:///C:/Windows/win.ini",
    "https://user:secret@example.com/",
  ])
    assert.throws(() => websiteUrl(value))
})

test(
  "authenticated real browser loads frame-denied pages, accepts input, and retains page history",
  { timeout: 60000 },
  async () => {
    const fixture = createServer((request, response) => {
      if (request.url === "/api/health") {
        response
          .writeHead(
            request.headers.authorization === "Bearer integration-only"
              ? 200
              : 401
          )
          .end()
        return
      }
      response.setHeader("X-Frame-Options", "DENY")
      response.setHeader("Content-Security-Policy", "frame-ancestors 'none'")
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      if (request.url === "/download") {
        response.setHeader("Content-Type", "text/plain")
        response.setHeader(
          "Content-Disposition",
          'attachment; filename="check.txt"'
        )
        response.end("download verified")
        return
      }
      if (request.url.startsWith("/submit")) {
        response.end(
          `<title>${new URL(request.url, "http://localhost").searchParams.get("query")}</title><h1>Form submitted</h1>`
        )
        return
      }
      response.end(
        '<title>Real browser fixture</title><script>console.log("before-sharing")</script><h1>Frame embedding denied</h1><form action="/submit"><input name="query" autofocus style="position:absolute;left:30px;top:90px;width:300px;height:40px"><button>Submit</button></form><input type="file" style="position:absolute;left:30px;top:180px;width:300px;height:40px" onchange="document.title=this.files[0].name"><a href="/download" style="position:absolute;left:30px;top:250px">Download</a><button style="position:absolute;left:30px;top:300px" onclick="alert(\'Dialog verified\')">Dialog</button><button style="position:absolute;left:400px;top:90px;width:100px;height:40px" onclick="window.tone=new AudioContext();let oscillator=tone.createOscillator();oscillator.frequency.value=440;oscillator.connect(tone.destination);oscillator.start()">Tone</button>'
      )
    })
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve))
    const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`
    const service = await startBrowserService({
      port: 0,
      authUrl: `${fixtureOrigin}/api/health`,
      origin: "https://codeg.odn.cc",
      dataDir: await mkdtemp(path.join(tmpdir(), "codeg-web-browser-test-")),
    })
    const origin = `http://127.0.0.1:${service.server.address().port}`
    let socket
    try {
      assert.notEqual((await fetch(`${origin}/health`)).status, 200)
      assert.equal(
        (
          await fetch(`${origin}/health`, {
            headers: { Authorization: "Bearer integration-only" },
          })
        ).status,
        200
      )
      const { createRequire } = await import("node:module")
      const { WebSocket } = createRequire(import.meta.url)(
        "next/dist/compiled/ws"
      )
      socket = new WebSocket(
        `${origin.replace("http:", "ws:")}/socket`,
        [
          "codeg-browser",
          `codeg-token.${Buffer.from("integration-only").toString("base64url")}`,
        ],
        { origin: "https://codeg.odn.cc" }
      )
      const messages = []
      socket.on("message", (raw) => messages.push(JSON.parse(String(raw))))
      await new Promise((resolve, reject) => {
        socket.once("open", resolve)
        socket.once("error", reject)
      })
      const send = (message) => socket.send(JSON.stringify(message))
      const mcp = async (name, args = {}) => {
        const response = await fetch(`${origin}/mcp`, {
          method: "POST",
          headers: {
            Authorization: "Bearer integration-only",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: Math.random(),
            method: "tools/call",
            params: { name, arguments: args },
          }),
        })
        assert.equal(response.status, 200)
        return (await response.json()).result
      }
      const wait = async (predicate) => {
        const deadline = Date.now() + 25000
        while (Date.now() < deadline) {
          const error = messages.find((message) => message.type === "error")
          if (error) throw new Error(error.message)
          const message = messages.find(predicate)
          if (message) return message
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        throw new Error(
          `Expected browser message was not received: ${JSON.stringify(messages.filter((item) => item.type !== "frame"))}`
        )
      }
      send({
        type: "open",
        tabId: "browser:integration",
        url: fixtureOrigin,
        navigate: true,
      })
      const initial = await wait(
        (message) =>
          message.type === "state" && message.title === "Real browser fixture"
      )
      assert.ok(initial.url.startsWith(fixtureOrigin))
      const frame = await wait((message) => message.type === "frame")
      assert.ok(Buffer.from(frame.data, "base64").length > 3000)
      const unshared = await mcp("browser_snapshot", {
        tabId: "browser:integration",
      })
      assert.equal(unshared.isError, true)
      assert.match(unshared.content[0].text, /browser_grant_required/)
      send({ type: "share", level: "read" })
      await wait(
        (message) => message.type === "state" && message.grant === "read"
      )
      const snapshotResult = await mcp("browser_snapshot", {
        tabId: "browser:integration",
      })
      assert.ok(!snapshotResult.isError, snapshotResult.content[0].text)
      const snapshot = JSON.parse(snapshotResult.content[0].text)
      assert.match(snapshot.tree, /Frame embedding denied/)
      const consoleResult = await mcp("browser_console_messages", {
        tabId: "browser:integration",
      })
      assert.deepEqual(
        JSON.parse(consoleResult.content[0].text).messages,
        [],
        "Sharing must not expose console output collected before consent"
      )
      const inputRef = snapshot.tree.match(/textbox[^\n]*\[ref=([^\]]+)\]/)?.[1]
      assert.ok(inputRef, snapshot.tree)
      const readOnly = await mcp("browser_type", {
        tabId: "browser:integration",
        generation: snapshot.generation,
        ref: inputRef,
        text: "agent input",
      })
      assert.equal(readOnly.isError, true)
      assert.match(readOnly.content[0].text, /browser_control_required/)
      send({ type: "share", level: "control" })
      await wait(
        (message) => message.type === "state" && message.grant === "control"
      )
      const controlled = JSON.parse(
        (await mcp("browser_snapshot", { tabId: "browser:integration" }))
          .content[0].text
      )
      const controlledRef = controlled.tree.match(
        /textbox[^\n]*\[ref=([^\]]+)\]/
      )?.[1]
      const typed = await mcp("browser_type", {
        tabId: "browser:integration",
        generation: controlled.generation,
        ref: controlledRef,
        text: "agent input",
      })
      assert.ok(!typed.isError, typed.content[0].text)
      const stale = await mcp("browser_type", {
        tabId: "browser:integration",
        generation: snapshot.generation,
        ref: inputRef,
        text: "must fail",
      })
      assert.equal(stale.isError, true)
      const screenshot = await mcp("browser_screenshot", {
        tabId: "browser:integration",
      })
      assert.equal(screenshot.content[0].type, "image")
      const consentPending = mcp("browser_eval", {
        tabId: "browser:integration",
        expression: 'console.log("while-shared"); document.title',
      })
      const evalRequest = await wait(
        (message) => message.type === "eval-request"
      )
      send({
        type: "eval-answer",
        requestId: evalRequest.requestId,
        approved: true,
      })
      const evaluated = await consentPending
      assert.equal(
        JSON.parse(evaluated.content[0].text).result,
        "Real browser fixture"
      )
      assert.deepEqual(
        JSON.parse(
          (
            await mcp("browser_console_messages", {
              tabId: "browser:integration",
            })
          ).content[0].text
        ).messages.map((item) => item.text),
        ["while-shared"]
      )
      const inspectorResult = await fetch(
        `${origin}/devtools-entry?tab=browser:integration`,
        {
          method: "POST",
          headers: { Authorization: "Bearer integration-only" },
        }
      )
      const inspectorEntry = (await inspectorResult.json()).url
      const inspectorCap = inspectorEntry.split("/").at(-1)
      const bounce = await fetch(`${origin}/devtools/enter/${inspectorCap}`, {
        redirect: "manual",
      })
      assert.equal(bounce.status, 302)
      const inspectorCookie = bounce.headers.get("set-cookie").split(";")[0]
      assert.equal(
        (
          await fetch(`${origin}/devtools/inspector.html`, {
            headers: { Cookie: inspectorCookie },
          })
        ).status,
        200
      )
      assert.equal(
        (await fetch(`${origin}/devtools/inspector.html`)).status,
        403
      )
      const inspectorSocket = new WebSocket(
        `${origin.replace("http:", "ws:")}/devtools/socket/${inspectorCap}`,
        {
          origin: "https://codeg-ego.odn.cc",
          headers: { Cookie: inspectorCookie },
        }
      )
      const inspectorMessages = []
      inspectorSocket.on("message", (raw) =>
        inspectorMessages.push(JSON.parse(String(raw)))
      )
      await new Promise((resolve, reject) => {
        inspectorSocket.once("open", resolve)
        inspectorSocket.once("error", reject)
      })
      inspectorSocket.send(
        JSON.stringify({
          id: 101,
          method: "Runtime.evaluate",
          params: { expression: "document.title", returnByValue: true },
        })
      )
      const inspectorDeadline = Date.now() + 10000
      while (
        !inspectorMessages.some((item) => item.id === 101) &&
        Date.now() < inspectorDeadline
      )
        await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(
        inspectorMessages.find((item) => item.id === 101)?.result.result.value,
        "Real browser fixture"
      )
      for (const [id, method, params] of [
        [102, "Network.clearBrowserCookies", {}],
        [103, "Storage.clearCookies", {}],
        [104, "Target.createTarget", { url: "https://example.com/" }],
        [105, "Network.getCookies", { urls: ["https://other.invalid/"] }],
      ])
        inspectorSocket.send(JSON.stringify({ id, method, params }))
      const restrictionDeadline = Date.now() + 10000
      while (
        !inspectorMessages.some((item) => item.id === 105) &&
        Date.now() < restrictionDeadline
      )
        await new Promise((resolve) => setTimeout(resolve, 30))
      for (const id of [102, 103, 104, 105])
        assert.ok(
          inspectorMessages.find((item) => item.id === id)?.error,
          `Inspector must refuse browser-wide or unrelated-site command ${id}`
        )
      inspectorSocket.close()
      const cleared = await mcp("browser_type", {
        tabId: "browser:integration",
        generation: controlled.generation,
        ref: controlledRef,
        text: "",
      })
      assert.ok(!cleared.isError)
      send({
        type: "pointer",
        event: "mousePressed",
        x: 440,
        y: 110,
        button: "left",
        buttons: 1,
      })
      send({
        type: "pointer",
        event: "mouseReleased",
        x: 440,
        y: 110,
        button: "left",
        buttons: 0,
      })
      send({ type: "audio", enabled: true })
      await wait((message) => message.type === "audio-start")
      const audioDeadline = Date.now() + 10000
      while (
        messages.filter((message) => message.type === "audio").length < 8 &&
        Date.now() < audioDeadline
      )
        await new Promise((resolve) => setTimeout(resolve, 100))
      const packets = messages.filter((message) => message.type === "audio")
      assert.ok(packets.length >= 8, "No browser audio packets")
      const encodedAudio = Buffer.concat(
        packets.map((packet) => Buffer.from(packet.data, "base64"))
      )
      const decoded = spawnSync(
        "F:/env/ffmpeg/bin/ffmpeg.exe",
        [
          "-hide_banner",
          "-i",
          "pipe:0",
          "-af",
          "volumedetect",
          "-f",
          "null",
          "-",
        ],
        { input: encodedAudio, encoding: "utf8", windowsHide: true }
      )
      assert.equal(decoded.status, 0, decoded.stderr)
      const volume = Number(
        decoded.stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/)?.[1]
      )
      assert.ok(
        volume > -50,
        `Audio must contain the test tone: ${decoded.stderr}`
      )
      send({ type: "audio", enabled: false })
      await wait((message) => message.type === "audio-stop")
      console.log(
        `AUDIO_PASS: ${packets.length} Opus packets, decoded mean ${volume} dB`
      )
      send({
        type: "pointer",
        event: "mousePressed",
        x: 70,
        y: 110,
        button: "left",
        buttons: 1,
      })
      send({
        type: "pointer",
        event: "mouseReleased",
        x: 70,
        y: 110,
        button: "left",
        buttons: 0,
      })
      send({ type: "text", text: "中文 online" })
      send({
        type: "key",
        event: "keyDown",
        key: "Enter",
        code: "Enter",
        keyCode: 13,
      })
      const submitted = await wait(
        (message) => message.type === "state" && message.title === "中文 online"
      )
      assert.ok(submitted.url.includes("/submit?query="))
      assert.equal(submitted.back, true)
      messages.length = 0
      send({ type: "history", direction: "back" })
      await wait(
        (message) =>
          message.type === "state" && message.title === "Real browser fixture"
      )
      messages.length = 0
      send({
        type: "pointer",
        event: "mousePressed",
        x: 80,
        y: 195,
        button: "left",
        buttons: 1,
      })
      send({
        type: "pointer",
        event: "mouseReleased",
        x: 80,
        y: 195,
        button: "left",
        buttons: 0,
      })
      await wait((message) => message.type === "upload")
      const uploaded = await fetch(`${origin}/upload?tab=browser:integration`, {
        method: "POST",
        headers: {
          Authorization: "Bearer integration-only",
          "Content-Type": "application/json",
          Origin: "https://codeg.odn.cc",
        },
        body: JSON.stringify({
          files: [
            {
              name: "upload-check.txt",
              data: Buffer.from("upload verified").toString("base64"),
            },
          ],
        }),
      })
      assert.equal(uploaded.status, 200, await uploaded.text())
      send({
        type: "pointer",
        event: "mousePressed",
        x: 60,
        y: 255,
        button: "left",
        buttons: 1,
      })
      send({
        type: "pointer",
        event: "mouseReleased",
        x: 60,
        y: 255,
        button: "left",
        buttons: 0,
      })
      const download = await wait((message) => message.type === "download")
      const file = await fetch(
        `${origin}/download?tab=browser:integration&id=${download.id}`,
        { headers: { Authorization: "Bearer integration-only" } }
      )
      assert.equal(file.status, 200)
      assert.equal(await file.text(), "download verified")
      send({
        type: "pointer",
        event: "mousePressed",
        x: 60,
        y: 310,
        button: "left",
        buttons: 1,
      })
      send({
        type: "pointer",
        event: "mouseReleased",
        x: 60,
        y: 310,
        button: "left",
        buttons: 0,
      })
      const dialog = await wait((message) => message.type === "dialog")
      assert.equal(dialog.message, "Dialog verified")
      send({ type: "dialog", accept: true })
      messages.length = 0
      send({ type: "navigate", url: "https://example.com/" })
      const online = await wait(
        (message) =>
          message.type === "state" && message.title === "Example Domain"
      )
      assert.equal(online.url, "https://example.com/")
      const revoked = await mcp("browser_snapshot", {
        tabId: "browser:integration",
      })
      assert.equal(revoked.isError, true)
      assert.match(revoked.content[0].text, /browser_grant_required/)
      const closed = await fetch(`${origin}/close?tab=browser:integration`, {
        method: "POST",
        headers: { Authorization: "Bearer integration-only" },
      })
      assert.equal(closed.status, 200)
      console.log(
        "PASS: authenticated browser, frame-denied page, screenshots, Chinese input, form, history, upload, download, dialog, close, public HTTPS"
      )
    } finally {
      socket?.close()
      await service.stop()
      await new Promise((resolve) => fixture.close(resolve))
    }
  }
)

test(
  "reusing a browser profile creates its own tab and leaves existing pages open",
  { timeout: 30000 },
  async () => {
    const fixture = createServer((request, response) => {
      if (request.url === "/api/health")
        response
          .writeHead(
            request.headers.authorization === "Bearer reuse-test" ? 200 : 401
          )
          .end()
      else response.end("<title>Existing page must survive</title>")
    })
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve))
    const url = `http://127.0.0.1:${fixture.address().port}`
    const dataDir = await mkdtemp(path.join(tmpdir(), "codeg-reuse-profile-"))
    const owned = await startBrowserService({
      port: 0,
      authUrl: `${url}/api/health`,
      origin: url,
      dataDir,
    })
    const { createRequire } = await import("node:module")
    const { WebSocket } = createRequire(import.meta.url)(
      "next/dist/compiled/ws"
    )
    const sockets = []
    let reused
    let cdp
    async function open(service, tabId) {
      const socket = new WebSocket(
        `ws://127.0.0.1:${service.server.address().port}/socket`,
        [
          "codeg-browser",
          `codeg-token.${Buffer.from("reuse-test").toString("base64url")}`,
        ],
        { origin: url }
      )
      sockets.push(socket)
      await new Promise((resolve, reject) => {
        socket.once("error", reject)
        socket.once("open", resolve)
      })
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Page did not load")),
          15000
        )
        socket.on("message", (raw) => {
          const message = JSON.parse(String(raw))
          if (
            message.type === "state" &&
            message.title === "Existing page must survive"
          ) {
            clearTimeout(timer)
            resolve()
          }
        })
        socket.send(JSON.stringify({ type: "open", tabId, url }))
      })
    }
    try {
      await open(owned, "original")
      const active = (
        await readFile(path.join(dataDir, "profile/DevToolsActivePort"), "utf8")
      )
        .trim()
        .split(/\r?\n/)
      cdp = new CdpConnection(`ws://127.0.0.1:${active[0]}${active[1]}`)
      await cdp.ready
      const before = (await cdp.call("Target.getTargets")).targetInfos.filter(
        (item) => item.type === "page"
      )
      reused = await startBrowserService({
        port: 0,
        authUrl: `${url}/api/health`,
        origin: url,
        dataDir: await mkdtemp(path.join(tmpdir(), "codeg-reused-service-")),
        existingProfile: path.join(dataDir, "profile"),
      })
      await open(reused, "separate")
      const during = (await cdp.call("Target.getTargets")).targetInfos.filter(
        (item) => item.type === "page"
      )
      assert.equal(during.length, before.length + 1)
      await reused.stop()
      let after
      const closedDeadline = Date.now() + 5000
      do {
        after = (await cdp.call("Target.getTargets")).targetInfos.filter(
          (item) => item.type === "page"
        )
        if (after.length === before.length) break
        await new Promise((resolve) => setTimeout(resolve, 30))
      } while (Date.now() < closedDeadline)
      assert.deepEqual(
        after.map((item) => item.targetId).sort(),
        before.map((item) => item.targetId).sort()
      )
    } finally {
      for (const socket of sockets) socket.close()
      await reused?.stop()
      cdp?.socket.close()
      await owned.stop()
      await new Promise((resolve) => fixture.close(resolve))
    }
  }
)

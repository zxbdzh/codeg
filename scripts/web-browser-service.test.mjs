import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { startBrowserService, websiteUrl } from "./web-browser-service.mjs"

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
        '<title>Real browser fixture</title><h1>Frame embedding denied</h1><form action="/submit"><input name="query" autofocus style="position:absolute;left:30px;top:90px;width:300px;height:40px"><button>Submit</button></form><input type="file" style="position:absolute;left:30px;top:180px;width:300px;height:40px" onchange="document.title=this.files[0].name"><a href="/download" style="position:absolute;left:30px;top:250px">Download</a><button style="position:absolute;left:30px;top:300px" onclick="alert(\'Dialog verified\')">Dialog</button>'
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

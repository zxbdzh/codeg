import assert from "node:assert/strict"
import { createServer, request as httpRequest } from "node:http"
import test from "node:test"
import websocket from "next/dist/compiled/ws/index.js"

const { WebSocket, WebSocketServer } = websocket
const { startBrowserStream } = await import(
  process.env.CODEG_TEST_BROWSER_STREAM_MODULE ||
    new URL("./web-browser-stream.mjs", import.meta.url).href
)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test("binary pipeline keeps four frames in flight and replaces stale pending frames", async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        authorization: request.headers.authorization,
        origin: request.headers.origin,
        path: request.url,
      })
    )
  })
  const backend = new WebSocketServer({ server })
  let producer
  let opened
  backend.on("connection", (socket) => {
    producer = socket
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw))
      if (message.type === "open") opened = message
      else if (message.type === "share")
        socket.send(JSON.stringify({ type: "state", grant: message.level }))
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const stream = await startBrowserStream({
    port: 0,
    upstream: `http://127.0.0.1:${server.address().port}`,
  })
  const origin = `http://127.0.0.1:${stream.server.address().port}`
  const client = new WebSocket(origin.replace("http:", "ws:") + "/socket", [
    "codeg-browser",
    "codeg-token.test",
  ])
  const frames = []
  const controls = []
  client.on("message", (raw, binary) => {
    if (binary) frames.push({ id: raw.readUInt32BE(), data: raw.subarray(4) })
    else controls.push(JSON.parse(String(raw)))
  })
  const until = async (check) => {
    const deadline = Date.now() + 3000
    while (!check() && Date.now() < deadline) await pause(10)
    assert.ok(check(), "Stream condition timed out")
  }
  try {
    await new Promise((resolve, reject) => {
      client.once("open", resolve)
      client.once("error", reject)
    })
    client.send(
      JSON.stringify({
        type: "open",
        tabId: "pipeline",
        flowControl: true,
        frameProtocol: "jpeg-v2",
      })
    )
    await until(() => opened)
    assert.equal(opened.flowControl, false)
    for (let index = 0; index < 12; index++)
      producer.send(
        JSON.stringify({
          type: "frame",
          data: Buffer.from([0xff, 0xd8, index]).toString("base64"),
        })
      )
    await until(() => frames.length === 4)
    await pause(50)
    assert.equal(frames.length, 4)
    client.send(JSON.stringify({ type: "frame-ack", id: 999 }))
    client.send(JSON.stringify({ type: "share", level: "read" }))
    await until(() => controls.some((item) => item.grant === "read"))
    assert.equal(frames.length, 4)
    client.send(JSON.stringify({ type: "frame-ack", id: frames[0].id }))
    await until(() => frames.length === 5)
    assert.equal(frames[4].data[2], 11, "Resume from the latest frame")
    client.send(JSON.stringify({ type: "frame-ack", id: frames[0].id }))
    await pause(30)
    assert.equal(frames.length, 5, "Duplicate ACK must not grant credit")
    const forwarded = await fetch(origin + "/health", {
      headers: {
        Authorization: "Bearer gateway-test",
        Origin: "https://codeg.odn.cc",
      },
    })
    assert.deepEqual(await forwarded.json(), {
      authorization: "Bearer gateway-test",
      origin: "https://codeg.odn.cc",
      path: "/health",
    })
    const unusualPath = await new Promise((resolve, reject) => {
      const request = httpRequest(
        origin,
        { path: "//%5B?frame=1" },
        (response) => {
          let body = ""
          response.on("data", (chunk) => (body += chunk))
          response.on("end", () => resolve(JSON.parse(body).path))
        }
      )
      request.on("error", reject)
      request.end()
    })
    assert.equal(unusualPath, "//%5B?frame=1")
    // 大帧不能占满四个窗口后继续排队，已发帧的字节预算也必须生效。
    for (const frame of frames.slice(1))
      client.send(JSON.stringify({ type: "frame-ack", id: frame.id }))
    await pause(30)
    for (let index = 0; index < 8; index++)
      producer.send(
        JSON.stringify({
          type: "frame",
          data: Buffer.alloc(220 * 1024, index).toString("base64"),
        })
      )
    await until(() => frames.length > 5)
    await pause(50)
    assert.equal(frames.length, 6, "Large frames must obey the byte budget")
    const disconnected = new Promise((resolve) => client.once("close", resolve))
    producer.send("null")
    assert.equal(await disconnected, 1011)
    assert.equal((await fetch(origin + "/health")).status, 200)
  } finally {
    client.close()
    stream.stop()
    for (const socket of backend.clients) socket.close()
    backend.close()
    await new Promise((resolve) => server.close(resolve))
  }
})

test("stream refuses a non-loopback upstream", async () => {
  await assert.rejects(
    startBrowserStream({ port: 0, upstream: "http://example.com:3199" }),
    /回环/
  )
})

test("an unavailable video capture keeps authenticated JPEG fallback working", async () => {
  let requestInfo
  const resizes = []
  const server = createServer((request, response) => {
    requestInfo = {
      method: request.method,
      path: request.url,
      origin: request.headers.origin,
      bearer: request.headers.authorization,
    }
    response.writeHead(403).end()
  })
  const backend = new WebSocketServer({ server })
  const opened = new Promise((resolve) => {
    backend.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw))
        if (message.type === "resize") resizes.push(message)
        if (message.type !== "open") return
        resolve(message)
        socket.send(JSON.stringify({ type: "state" }))
        socket.send(
          JSON.stringify({
            type: "frame",
            data: Buffer.from([255, 216, 255]).toString("base64"),
            id: 7,
          })
        )
      })
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const stream = await startBrowserStream({
    port: 0,
    upstream: `http://127.0.0.1:${server.address().port}`,
    videoProfile: "unused",
  })
  const origin = "https://codeg.odn.cc"
  const encoded = Buffer.from("unit-test").toString("base64url")
  const client = new WebSocket(
    `ws://127.0.0.1:${stream.server.address().port}/socket`,
    ["codeg-browser", `codeg-token.${encoded}`],
    { origin }
  )
  try {
    await new Promise((resolve, reject) => {
      client.once("open", resolve)
      client.once("error", reject)
    })
    const jpeg = new Promise((resolve) =>
      client.on("message", (raw, binary) => {
        if (binary) resolve(raw.subarray(4))
      })
    )
    client.send(
      JSON.stringify({
        type: "open",
        tabId: "fallback-test",
        flowControl: true,
        frameProtocol: "jpeg-v2",
        videoProtocol: "vp8-v1",
      })
    )
    assert.equal((await opened).flowControl, true)
    const viewport = { type: "resize", width: 391, height: 728, mobile: true }
    client.send(JSON.stringify(viewport))
    assert.deepEqual(await jpeg, Buffer.from([255, 216, 255]))
    for (let attempt = 0; attempt < 30 && !requestInfo; attempt++)
      await pause(10)
    assert.deepEqual(requestInfo, {
      method: "POST",
      path: "/devtools-entry?tab=fallback-test",
      origin,
      bearer: "Bearer unit-test",
    })
    for (let attempt = 0; attempt < 30 && resizes.length < 2; attempt++)
      await pause(10)
    assert.deepEqual(
      resizes,
      [viewport, viewport],
      "Capture completion must restore the page viewport after window sizing"
    )
  } finally {
    client.terminate()
    stream.stop()
    for (const socket of backend.clients) socket.terminate()
    backend.close()
    await new Promise((resolve) => server.close(resolve))
  }
})

test(
  "stopping the stream closes pending WebSocket upgrades",
  { timeout: 5000 },
  async () => {
    const server = createServer()
    let upstreamSocket
    const pendingUpgrade = new Promise((resolve) => {
      server.once("upgrade", (_request, socket) => {
        upstreamSocket = socket
        resolve()
      })
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const stream = await startBrowserStream({
      port: 0,
      upstream: `http://127.0.0.1:${server.address().port}`,
    })
    const client = new WebSocket(
      `ws://127.0.0.1:${stream.server.address().port}/socket`
    )
    client.on("error", () => {})
    const disconnected = new Promise((resolve) => client.once("close", resolve))
    try {
      await pendingUpgrade
      stream.stop()
      const closed = await Promise.race([
        disconnected.then(() => true),
        pause(1000).then(() => false),
      ])
      assert.equal(closed, true)
    } finally {
      client.terminate()
      stream.stop()
      upstreamSocket?.destroy()
      await new Promise((resolve) => server.close(resolve))
    }
  }
)

test("stream preserves upstream authentication rejection before upgrading", async () => {
  const server = createServer()
  let receivedOrigin
  server.on("upgrade", (request, socket) => {
    receivedOrigin = request.headers.origin
    socket.end(
      "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const stream = await startBrowserStream({
    port: 0,
    upstream: `http://127.0.0.1:${server.address().port}`,
  })
  const client = new WebSocket(
    `ws://127.0.0.1:${stream.server.address().port}/socket`,
    { origin: "https://invalid.example" }
  )
  client.on("error", () => {})
  try {
    const status = await new Promise((resolve, reject) => {
      client.once("open", () =>
        reject(new Error("An unauthorized viewer was accepted"))
      )
      client.once("unexpected-response", (_request, response) => {
        response.resume()
        resolve(response.statusCode)
        client.terminate()
      })
    })
    assert.equal(status, 401)
    assert.equal(receivedOrigin, "https://invalid.example")
  } finally {
    client.terminate()
    stream.stop()
    await new Promise((resolve) => server.close(resolve))
  }
})

import assert from "node:assert/strict"
import test from "node:test"
import { createContext, runInContext } from "node:vm"

import { createBrowserAgent } from "./web-browser-agent.mjs"

function deferred() {
  let resolve
  const promise = new Promise((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function fixture(context) {
  const owner = "owner"
  const tabId = "browser:tab"
  const source = `
    globalThis.__codegAgent = {
      snapshot: () => ({ generation: "generation", tree: "private-snapshot" }),
      act: () => {
        globalThis.actions++
        return { ok: true, detail: "private-action" }
      }
    }
  `
  const session = {
    key: `${owner}:${tabId}`,
    tabId,
    epoch: 0,
    grant: { origin: "https://example.com", level: "control" },
    snapshot: { generation: "generation", epoch: 0 },
    console: [{ text: "private-console" }],
    socket: { readyState: 1 },
  }
  const worlds = new Map()
  const boundaries = []
  let frame = { id: "frame", url: "https://example.com/page" }
  let main = createContext({
    document: { title: "private-eval", evalRuns: 0 },
  })
  let approval = deferred()
  let world
  let sequence = 0

  function pause(
    method,
    { occurrence = 1, before = false, match = () => true } = {}
  ) {
    const reached = deferred()
    const resumed = deferred()
    const boundary = { method, occurrence, before, match, reached, resumed }
    boundaries.push(boundary)
    return { reached: reached.promise, resume: resumed.resolve }
  }

  async function pageCall(_session, method, params = {}) {
    const boundary = boundaries.find(
      (candidate) =>
        candidate.method === method &&
        candidate.match(params) &&
        --candidate.occurrence === 0
    )
    async function wait() {
      boundary.reached.resolve(params)
      const error = await boundary.resumed.promise
      if (error) throw error
    }
    if (boundary?.before) await wait()
    let result
    if (method === "Page.getFrameTree") result = { frameTree: { frame } }
    else if (method === "Page.createIsolatedWorld") {
      if (!world) {
        world = {
          id: ++sequence,
          context: createContext({
            location: { origin: new URL(frame.url).origin },
            document: main.document,
            actions: 0,
          }),
        }
        runInContext(source, world.context)
        worlds.set(world.id, world)
      }
      result = { executionContextId: world.id }
    } else if (method === "Runtime.evaluate") {
      const target = params.contextId
        ? worlds.get(params.contextId)
        : { context: main }
      if (!target) throw new Error("Execution context was destroyed")
      const value = runInContext(params.expression, target.context)
      result = { result: { value: params.awaitPromise ? await value : value } }
    } else if (method === "Page.captureScreenshot")
      result = { data: "private-screenshot" }
    else throw new Error(`Unexpected CDP method: ${method}`)
    if (boundary && !boundary.before) await wait()
    return result
  }

  const agent = createBrowserAgent({
    sessions: new Map([[session.key, session]]),
    pageCall,
    send: (_session, message) => {
      if (message.type === "eval-request") approval.resolve(message)
    },
    source,
    websiteUrl: (value) => new URL(value).href,
  })
  context.after(() => {
    session.pendingEval?.resolve(false)
    for (const boundary of boundaries) boundary.resumed.resolve()
  })
  return {
    session,
    pause,
    waitForApproval: () => approval.promise,
    call: (name, args = {}) =>
      agent(owner, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: { tabId, ...args } },
      }),
    async answer(approved) {
      const request = await approval.promise
      approval = deferred()
      assert.equal(session.pendingEval.requestId, request.requestId)
      session.pendingEval.resolve(approved)
      return request
    },
    navigate({ notify = true } = {}) {
      if (notify) session.epoch++
      frame = { ...frame, url: "https://example.com/next" }
      main = createContext({
        document: { title: "private-new-page", evalRuns: 0 },
      })
      worlds.clear()
      world = undefined
    },
    evalRuns: () => main.document.evalRuns,
    actions: () =>
      [...worlds.values()].reduce(
        (total, entry) => total + entry.context.actions,
        0
      ),
  }
}

function denied(response, code = "browser_stale_ref") {
  assert.equal(response.result.isError, true)
  assert.equal(JSON.parse(response.result.content[0].text).error, code)
  assert.doesNotMatch(JSON.stringify(response), /private-/)
}

test(
  "console data is withheld when sharing is revoked during CDP evaluation",
  { timeout: 1000 },
  async (context) => {
    const browser = fixture(context)
    const boundary = browser.pause("Runtime.evaluate")
    const pending = browser.call("browser_console_messages")
    await boundary.reached
    browser.session.grant = null
    boundary.resume()
    denied(await pending)
  }
)

test(
  "an action cannot execute after control is downgraded while creating its world",
  { timeout: 1000 },
  async (context) => {
    const browser = fixture(context)
    const boundary = browser.pause("Page.createIsolatedWorld", {
      occurrence: 2,
    })
    const pending = browser.call("browser_click", {
      generation: "generation",
      ref: "button",
    })
    await boundary.reached
    browser.session.grant = { ...browser.session.grant, level: "read" }
    boundary.resume()
    denied(await pending)
    assert.equal(browser.actions(), 0)
  }
)

test(
  "action results are withheld when sharing is revoked during execution",
  { timeout: 1000 },
  async (context) => {
    const browser = fixture(context)
    const boundary = browser.pause("Runtime.evaluate", { occurrence: 2 })
    const pending = browser.call("browser_click", {
      generation: "generation",
      ref: "button",
    })
    await boundary.reached
    browser.session.grant = null
    boundary.resume()
    denied(await pending)
  }
)

test(
  "approved eval never falls through to a new document before navigation is reported",
  { timeout: 1000 },
  async (context) => {
    const browser = fixture(context)
    const expression = "document.evalRuns++; document.title"
    const boundary = browser.pause("Runtime.evaluate", {
      before: true,
      match: (params) => params.expression === expression,
    })
    const pending = browser.call("browser_eval", { expression })
    await browser.answer(true)
    await boundary.reached
    // 模拟新文档已提交，但导航事件尚未更新服务端 epoch。
    browser.navigate({ notify: false })
    boundary.resume()
    denied(await pending, "browser_action_failed")
    assert.equal(browser.evalRuns(), 0)
  }
)

const authorizationChanges = [
  [
    "revoked",
    (browser) => {
      browser.session.grant = null
    },
  ],
  [
    "replaced",
    (browser) => {
      browser.session.grant = { ...browser.session.grant }
    },
  ],
  [
    "downgraded",
    (browser) => {
      browser.session.grant = { ...browser.session.grant, level: "read" }
    },
  ],
  [
    "level edited",
    (browser) => {
      browser.session.grant.level = "read"
    },
  ],
  [
    "origin edited",
    (browser) => {
      browser.session.grant.origin = "https://other.example"
    },
  ],
  ["navigated", (browser) => browser.navigate()],
]

for (const method of [
  "Page.getFrameTree",
  "Page.createIsolatedWorld",
  "Runtime.evaluate",
]) {
  for (const [change, applyChange] of authorizationChanges) {
    test(
      `console access is rejected when authorization is ${change} during ${method}`,
      { timeout: 1000 },
      async (context) => {
        const browser = fixture(context)
        const boundary = browser.pause(method)
        const pending = browser.call("browser_console_messages")
        await boundary.reached
        applyChange(browser)
        boundary.resume()
        denied(await pending)
      }
    )
  }
}

for (const [method, occurrence] of [
  ["Page.getFrameTree", 2],
  ["Page.createIsolatedWorld", 2],
  ["Runtime.evaluate", 2],
  ["Page.getFrameTree", 3],
  ["Page.createIsolatedWorld", 3],
  ["Runtime.evaluate", 3],
]) {
  test(
    `snapshot is withheld when navigation happens during ${method} #${occurrence}`,
    { timeout: 1000 },
    async (context) => {
      const browser = fixture(context)
      browser.session.snapshot = null
      const boundary = browser.pause(method, { occurrence })
      const pending = browser.call("browser_snapshot")
      await boundary.reached
      browser.navigate()
      boundary.resume()
      denied(await pending)
      assert.equal(browser.session.snapshot, null)
    }
  )
}

test(
  "screenshots are withheld when sharing is revoked during capture",
  { timeout: 1000 },
  async (context) => {
    const browser = fixture(context)
    const boundary = browser.pause("Page.captureScreenshot")
    const pending = browser.call("browser_screenshot")
    await boundary.reached
    browser.session.grant = null
    boundary.resume()
    denied(await pending)
  }
)

test("shared pages still return snapshots, console data and screenshots", async (context) => {
  const browser = fixture(context)
  browser.session.grant.level = "read"
  for (const [name, expected] of [
    [
      "browser_snapshot",
      { generation: "generation", tree: "private-snapshot" },
    ],
    ["browser_console_messages", { messages: [{ text: "private-console" }] }],
  ]) {
    const response = await browser.call(name)
    assert.equal(response.result.isError, undefined)
    assert.deepEqual(JSON.parse(response.result.content[0].text), expected)
  }
  const screenshot = await browser.call("browser_screenshot")
  assert.deepEqual(screenshot.result.content, [
    { type: "image", data: "private-screenshot", mimeType: "image/png" },
  ])
})

for (const name of [
  "browser_click",
  "browser_hover",
  "browser_type",
  "browser_press_key",
  "browser_select_option",
]) {
  test(`${name} still works with an unchanged control grant`, async (context) => {
    const browser = fixture(context)
    const response = await browser.call(name, {
      generation: "generation",
      ref: "field",
      text: "hello",
      key: "Enter",
      values: ["option"],
    })
    assert.equal(response.result.isError, undefined)
    assert.deepEqual(JSON.parse(response.result.content[0].text), {
      ok: true,
      detail: "private-action",
    })
    assert.equal(browser.actions(), 1)
  })
}

test(
  "every eval needs approval for its exact snippet and a declined snippet never runs",
  { timeout: 1000 },
  async (context) => {
    const browser = fixture(context)
    const expression = "document.title"
    const first = browser.call("browser_eval", { expression })
    const approved = await browser.answer(true)
    assert.equal(approved.expression, expression)
    assert.deepEqual(JSON.parse((await first).result.content[0].text), {
      result: "private-eval",
    })
    assert.equal(browser.evalRuns(), 0)
    const declinedExpression = "document.evalRuns++; document.title"
    const second = browser.call("browser_eval", {
      expression: declinedExpression,
    })
    const declined = await browser.answer(false)
    assert.equal(declined.expression, declinedExpression)
    assert.notEqual(declined.requestId, approved.requestId)
    denied(await second, "browser_eval_declined")
    assert.equal(browser.evalRuns(), 0)
  }
)

for (const [change, applyChange] of authorizationChanges) {
  test(
    `eval approval cannot reuse authorization that was ${change}`,
    { timeout: 1000 },
    async (context) => {
      const browser = fixture(context)
      const pending = browser.call("browser_eval", {
        expression: "document.evalRuns++",
      })
      await browser.waitForApproval()
      applyChange(browser)
      await browser.answer(true)
      denied(await pending)
      assert.equal(browser.evalRuns(), 0)
    }
  )
}

test(
  "approved eval results are withheld after sharing is revoked",
  { timeout: 1000 },
  async (context) => {
    const browser = fixture(context)
    const expression = "document.title"
    const boundary = browser.pause("Runtime.evaluate", {
      match: (params) => params.expression === expression,
    })
    const pending = browser.call("browser_eval", { expression })
    await browser.answer(true)
    await boundary.reached
    browser.session.grant = null
    boundary.resume()
    denied(await pending)
  }
)

for (const name of [
  "browser_snapshot",
  "browser_click",
  "browser_console_messages",
  "browser_eval",
]) {
  test(
    `${name} does not leak CDP errors after sharing is revoked`,
    { timeout: 1000 },
    async (context) => {
      const browser = fixture(context)
      const expression = "document.title"
      const boundary = browser.pause("Runtime.evaluate", {
        occurrence: name === "browser_click" ? 2 : 1,
        match:
          name === "browser_eval"
            ? (params) => params.expression === expression
            : () => true,
      })
      const pending = browser.call(name, {
        expression,
        generation: "generation",
        ref: "field",
      })
      if (name === "browser_eval") await browser.answer(true)
      await boundary.reached
      browser.session.grant = null
      boundary.resume(new Error("private-cdp-error"))
      denied(await pending)
    }
  )
}

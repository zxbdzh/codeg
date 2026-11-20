import { randomBytes } from "node:crypto"

export const browserTools = [
  [
    "browser_list_tabs",
    "List Codeg Web browser tabs. Page content is available only after the user shares that tab.",
    {},
  ],
  [
    "browser_snapshot",
    "Read the shared page as an accessibility tree. Use its generation and refs for actions.",
    { tabId: "string", maxChars: "number" },
  ],
  [
    "browser_click",
    "Click a ref in the shared page. Requires Allow actions.",
    { tabId: "string", generation: "string", ref: "string" },
  ],
  [
    "browser_hover",
    "Hover over a ref. Requires Allow actions.",
    { tabId: "string", generation: "string", ref: "string" },
  ],
  [
    "browser_type",
    "Replace a field by ref with text; submit optionally. Requires Allow actions.",
    {
      tabId: "string",
      generation: "string",
      ref: "string",
      text: "string",
      submit: "boolean",
    },
  ],
  [
    "browser_press_key",
    "Press a key in the shared page. Requires Allow actions.",
    { tabId: "string", generation: "string", key: "string", ref: "string" },
  ],
  [
    "browser_select_option",
    "Select options in a field by ref. Requires Allow actions.",
    { tabId: "string", generation: "string", ref: "string", values: "array" },
  ],
  [
    "browser_screenshot",
    "Capture the shared page. Requires Share with agents.",
    { tabId: "string" },
  ],
  [
    "browser_console_messages",
    "Read console messages from the shared page.",
    { tabId: "string" },
  ],
  [
    "browser_eval",
    "Run JavaScript only after the user approves this exact snippet in Codeg.",
    { tabId: "string", expression: "string" },
  ],
  [
    "browser_open_tab",
    "Open an HTTP or HTTPS page in Codeg. Opening does not grant read or control access.",
    { url: "string" },
  ],
  [
    "browser_navigate",
    "Navigate a shared page. Requires Allow actions; leaving the origin revokes sharing.",
    { tabId: "string", url: "string" },
  ],
  [
    "browser_close_tab",
    "Close a shared page. Requires Allow actions.",
    { tabId: "string" },
  ],
].map(([name, description, fields]) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(fields).map(([key, type]) => [
        key,
        { type, ...(type === "array" ? { items: { type: "string" } } : {}) },
      ])
    ),
    required: Object.keys(fields).filter(
      (key) =>
        !["maxChars", "submit"].includes(key) &&
        !(name === "browser_press_key" && key === "ref")
    ),
    additionalProperties: false,
  },
}))

function refusal(code, message) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: code, message }) }],
  }
}
const text = (result) => ({
  content: [{ type: "text", text: JSON.stringify(result) }],
})

export function createBrowserAgent({
  sessions,
  pageCall,
  send,
  createSession,
  closeSession,
  source,
  websiteUrl,
}) {
  async function executionContext(session, access) {
    access.check()
    const current = await pageCall(session, "Page.getFrameTree")
    access.check()
    const frame = current.frameTree.frame
    if (access.origin !== new URL(frame.url).origin)
      throw new Error("browser_grant_required")
    const world = await pageCall(session, "Page.createIsolatedWorld", {
      frameId: frame.id,
      worldName: "codeg-web-agent",
    })
    access.check()
    return world.executionContextId
  }

  async function evaluate(session, expression, access) {
    const contextId = await executionContext(session, access)
    access.check()
    const result = await pageCall(session, "Runtime.evaluate", {
      expression: `(()=>{if(location.origin!==${JSON.stringify(access.origin)})throw new Error("browser_grant_required");${expression}})()`,
      contextId,
      returnByValue: true,
      awaitPromise: false,
    })
    access.check()
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text
      )
    return result.result.value
  }

  async function prepare(session, access) {
    await evaluate(session, `if(!globalThis.__codegAgent){${source}\n}`, access)
  }

  async function run(owner, name, args) {
    let access
    try {
      if (name === "browser_list_tabs")
        return text({
          tabs: [...sessions.values()]
            .filter((session) => session.key.startsWith(`${owner}:`))
            .map((session) => ({
              tabId: session.tabId,
              shared: Boolean(session.grant),
              control: session.grant?.level === "control",
              ...(session.grant
                ? { url: session.url, title: session.title || "" }
                : {}),
            })),
        })
      if (name === "browser_open_tab") {
        const url = websiteUrl(args.url)
        const viewer = [...sessions.values()].find(
          (session) =>
            session.key.startsWith(`${owner}:`) &&
            session.socket?.readyState === 1
        )
        if (!viewer)
          throw new Error("Open Codeg Web and its browser panel first")
        const tabId = `browser:web-${randomBytes(12).toString("hex")}`
        const page = await createSession(`${owner}:${tabId}`, url)
        send(viewer, { type: "agent-open", tabId, url })
        return text({ tabId: page.tabId, url, shared: false })
      }
      const session = sessions.get(`${owner}:${args.tabId}`)
      if (!session)
        return refusal("browser_no_such_tab", "No such Codeg Web tab")
      const write = ![
        "browser_snapshot",
        "browser_console_messages",
        "browser_screenshot",
      ].includes(name)
      // 旧请求不能借重新共享或降权后的授权继续执行。
      const epoch = session.epoch
      const grant = session.grant
      const origin = grant?.origin
      const level = grant?.level
      const check = () => {
        if (!grant) throw new Error("browser_grant_required")
        if (
          !session.grant ||
          session.grant !== grant ||
          session.epoch !== epoch ||
          grant.origin !== origin ||
          grant.level !== level
        )
          throw new Error("browser_stale_ref")
        if (write && level !== "control")
          throw new Error("browser_control_required")
      }
      access = { check, origin }
      await evaluate(session, "return true", access)
      check()
      send(session, { type: "agent-activity", action: name, at: Date.now() })
      if (name === "browser_snapshot") {
        await prepare(session, access)
        const snapshot = await evaluate(
          session,
          `return __codegAgent.snapshot(${JSON.stringify({ maxChars: Math.min(100000, Math.max(1000, Number(args.maxChars) || 40000)), epoch: String(epoch) })})`,
          access
        )
        check()
        session.snapshot = {
          generation: snapshot.generation,
          epoch: session.epoch,
        }
        return text(snapshot)
      }
      if (name === "browser_console_messages")
        return text({ messages: session.console || [] })
      if (name === "browser_screenshot") {
        const capture = await pageCall(session, "Page.captureScreenshot", {
          format: "png",
        })
        check()
        return {
          content: [
            { type: "image", data: capture.data, mimeType: "image/png" },
          ],
        }
      }
      if (name === "browser_navigate") {
        const url = websiteUrl(args.url)
        check()
        await pageCall(session, "Page.navigate", { url })
        return text({ tabId: args.tabId, requestedUrl: url })
      }
      if (name === "browser_close_tab") {
        check()
        send(session, { type: "agent-close" })
        await closeSession(session)
        return text({ closed: true })
      }
      if (name === "browser_eval") {
        const expression = args.expression
        if (typeof expression !== "string" || expression.length > 20000)
          throw new Error("Invalid expression")
        if (!session.socket || session.pendingEval)
          throw new Error(
            "A browser must be watching; only one approval may be pending"
          )
        const requestId = randomBytes(16).toString("hex")
        const consent = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (session.pendingEval?.requestId === requestId)
              session.pendingEval = null
            resolve(false)
          }, 120000)
          session.pendingEval = {
            requestId,
            resolve: (approved) => {
              clearTimeout(timer)
              session.pendingEval = null
              resolve(approved)
            },
          }
          send(session, {
            type: "eval-request",
            requestId,
            expression,
          })
        })
        if (!consent)
          return refusal(
            "browser_eval_declined",
            "User did not approve this snippet"
          )
        check()
        const contextId = await executionContext(session, access)
        check()
        const result = await pageCall(session, "Runtime.evaluate", {
          expression,
          // 不使用默认上下文，避免导航竞态把已批准代码执行到新页面。
          contextId,
          returnByValue: true,
          awaitPromise: true,
          timeout: 10000,
        })
        check()
        return text({
          result: result.result.value,
          exception: result.exceptionDetails?.text,
        })
      }
      if (
        !session.snapshot ||
        session.snapshot.epoch !== session.epoch ||
        session.snapshot.generation !== args.generation
      )
        throw new Error("browser_stale_ref")
      const kind = {
        browser_click: "click",
        browser_hover: "hover",
        browser_type: "type",
        browser_press_key: "press",
        browser_select_option: "select",
      }[name]
      if (!kind) throw new Error("Unknown browser tool")
      const action = {
        kind,
        ...(kind === "type"
          ? { text: args.text, submit: Boolean(args.submit) }
          : {}),
        ...(kind === "press" ? { key: args.key } : {}),
        ...(kind === "select" ? { values: args.values } : {}),
      }
      const result = await evaluate(
        session,
        `return __codegAgent.act(${JSON.stringify(args.generation)},${JSON.stringify(args.ref || null)},${JSON.stringify(action)})`,
        access
      )
      check()
      if (!result.ok)
        return refusal(
          result.error === "stale"
            ? "browser_stale_ref"
            : "browser_action_failed",
          result.detail || result.error
        )
      return text(result)
    } catch (error) {
      try {
        access?.check()
      } catch (revoked) {
        error = revoked
      }
      const code =
        [
          "browser_grant_required",
          "browser_control_required",
          "browser_stale_ref",
        ].find((candidate) => error.message.includes(candidate)) ||
        "browser_action_failed"
      return refusal(
        code,
        code === "browser_grant_required"
          ? "Ask the user to Share with agents in this tab. Only they can authorize access."
          : code === "browser_control_required"
            ? "Ask the user to choose Allow actions in this tab."
            : error.message
      )
    }
  }

  return async (owner, request) => {
    if (!Object.hasOwn(request, "id")) return null
    const base = { jsonrpc: "2.0", id: request.id }
    if (request.method === "initialize")
      return {
        ...base,
        result: {
          protocolVersion: request.params?.protocolVersion || "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "codeg-web-browser", version: "1.0.0" },
        },
      }
    if (request.method === "ping") return { ...base, result: {} }
    if (request.method === "tools/list")
      return { ...base, result: { tools: browserTools } }
    if (request.method === "tools/call")
      return {
        ...base,
        result: await run(
          owner,
          request.params?.name,
          request.params?.arguments || {}
        ),
      }
    return { ...base, error: { code: -32601, message: "Method not found" } }
  }
}

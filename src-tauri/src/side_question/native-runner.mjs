import { spawn, execFile } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { createInterface } from "node:readline"
import { fileURLToPath, pathToFileURL } from "node:url"

const MAX_FRAME_BYTES = 8 * 1024 * 1024

export function packageDirectory(program, name) {
  for (const start of [dirname(resolve(program)), dirname(realpathSync(program))]) {
    let directory = start
    for (let depth = 0; depth < 7; depth += 1) {
      for (const candidate of [directory, join(directory, "node_modules", name)]) {
        const manifest = join(candidate, "package.json")
        if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) {
          return candidate
        }
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  throw new Error(`The connection's ${name} package is unavailable`)
}

async function piRuntime(request) {
  const directory = packageDirectory(request.program, "@earendil-works/pi-coding-agent")
  const plugin = packageDirectory(request.program, "pi-btw")
  const version = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version
  const pluginVersion = JSON.parse(readFileSync(join(plugin, "package.json"), "utf8")).version
  if (!versionAtLeast(version, [1, 5, 0]) || !versionAtLeast(pluginVersion, [0, 8, 1])) {
    throw new Error("Pi or pi-btw is too old for this native bridge")
  }
  return { sdk: join(directory, "dist", "index.js"), plugin, version, minimum: [1, 5, 0] }
}

export function completedPiLeaf(entries) {
  return entries.findLast((entry) =>
    entry.type === "message" &&
    entry.message?.role === "assistant" &&
    entry.message.stopReason === "stop"
  )?.id ?? null
}

async function askPi(runtime, request) {
  if (request.images?.length) throw new Error("The Pi side-question plugin accepts text only")
  const sdk = await import(pathToFileURL(runtime.sdk).href)
  const file = sdk.SessionManager.findById(request.cwd, request.sessionId)
  if (!file) throw new Error("The current native Pi session is unavailable")
  const entries = readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse)
  if (entries[0]?.type !== "session" || entries[0].id !== request.sessionId) {
    throw new Error("Pi session identity does not match the connection")
  }
  const modelRuntime = await sdk.ModelRuntime.create({ allowModelNetwork: false })
  const model = modelRuntime.getAllModels().find(
    (candidate) => `${candidate.provider}/${candidate.id}` === request.model
  )
  if (!model) throw new Error("The connection's Pi model is unavailable")
  const settings = sdk.SettingsManager.inMemory({})
  const loader = new sdk.DefaultResourceLoader({
    cwd: request.cwd,
    agentDir: sdk.getAgentDir(),
    settingsManager: settings,
    // 仅加载已安装的旁问插件，避免重放主线扩展的启动钩子或自动安装其他包。
    noExtensions: true,
    additionalExtensionPaths: [join(runtime.plugin, "extensions", "btw.ts")],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  })
  await loader.reload()
  if (loader.getExtensions().errors.length) throw new Error("The Pi side-question plugin could not load")
  // 原生日志只读；插件的隐藏状态和会话备注全部写入内存副本。
  const memory = sdk.SessionManager.inMemory(request.cwd, undefined, entries)
  const completedLeaf = completedPiLeaf(memory.getBranch())
  // 主线正在生成时，只继承最后一个已完成回合，不把悬空工具调用带入旁问。
  if (completedLeaf) memory.branch(completedLeaf)
  else memory.resetLeaf()
  memory.appendCustomEntry("btw-thread-reset", { timestamp: Date.now(), mode: "readonly" })
  for (const pair of claudeHistory(request.history)) {
    memory.appendCustomEntry("btw-thread-entry", {
      question: pair.question, answer: pair.response, thinking: "",
      provider: model.provider, model: model.id, api: model.api,
      thinkingLevel: request.effort ?? "off", timestamp: Date.now(),
    })
  }
  const { session } = await sdk.createAgentSession({
    cwd: request.cwd,
    modelRuntime,
    model,
    thinkingLevel: request.effort ?? "off",
    tools: [],
    sessionManager: memory,
    settingsManager: settings,
    resourceLoader: loader,
  })
  let callable = false
  try {
    await session.bindExtensions({
      onError: () => { throw new Error("The Pi side-question plugin failed") },
    })
    callable = Boolean(session.extensionRunner.getCommand("btw:ask"))
    if (!callable) throw new Error("The installed Pi plugin has no callable side-question command")
    if (request.operation === "probe") return { supported: true, images: false }
    await session.prompt(`/btw:ask ${request.question}`)
    const note = session.state.messages.findLast(
      (message) => message.role === "custom" && message.customType === "btw-note"
    )
    if (!note?.details?.answer?.trim()) throw new Error("The Pi plugin did not return a side-question answer")
    return { answer: note.details.answer }
  } finally {
    try {
      if (callable) await session.prompt("/btw:clear")
    } finally {
      session.dispose()
    }
  }
}

async function dshRuntime(request) {
  const directory = packageDirectory(request.program, "deepseek-acp")
  const require = createRequire(join(directory, "package.json"))
  const plugin = packageDirectory(request.program, "@dsh-external/dsh-sidechain")
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
  const pluginManifest = JSON.parse(readFileSync(join(plugin, "package.json"), "utf8"))
  const version = manifest.version
  const harness = manifest.dependencies["@deepseek-ai/dsh-agent-loop"]
  // Cordis 服务与日志格式按运行时系列配套，不能把旧插件强挂到新会话上。
  if (!versionAtLeast(version, [0, 11, 0]) ||
      !pluginManifest.peerDependencies["@deepseek-ai/dsh-agent"].includes(harness)) {
    throw new Error("DSH Sidechain is incompatible with the connection's runtime")
  }
  const load = (name) => import(pathToFileURL(require.resolve(name)).href)
  await load("@deepseek-ai/dsh-subagent")
  await load("@deepseek-ai/dsh-subagent-fork-in-process")
  return { directory, plugin, load, version, minimum: [0, 11, 0] }
}

async function askDsh(runtime, request) {
  if (request.images?.length) throw new Error("This DSH side-question bridge accepts text only")
  const { load, directory } = runtime
  const [{ Context }, boot, persistence, subagent, fork, plugin, credentials, deepseek, settings, piAi, sessionTypes] = await Promise.all([
    load("@deepseek-ai/cordis"),
    import(pathToFileURL(join(directory, "lib", "launcher", "boot.js")).href),
    load("@deepseek-ai/dsh-session-persistence-jsonl"),
    load("@deepseek-ai/dsh-subagent"),
    load("@deepseek-ai/dsh-subagent-fork-in-process"),
    import(pathToFileURL(join(runtime.plugin, "lib", "index.js")).href),
    load("@deepseek-ai/dsh-credentials-local"),
    load("@deepseek-ai/dsh-llm-deepseek-api-key"),
    import(pathToFileURL(join(directory, "lib", "composition", "settings.js")).href),
    import(pathToFileURL(join(directory, "lib", "composition", "pi-ai.js")).href),
    load("@deepseek-ai/dsh-session"),
  ])
  const reader = new Context()
  let stored
  try {
    await reader.plugin(persistence, { root: boot.sessionsRoot(process.env) })
    const handle = await reader.sessionPersistence.open(sessionTypes.SessionId(request.sessionId), "read")
    try {
      stored = { header: handle.header, events: (await handle.read()).events }
    } finally {
      await handle.close()
    }
  } finally {
    await reader.fiber.dispose()
  }
  if (resolve(stored.header.cwd) !== resolve(request.cwd)) throw new Error("DSH session workspace does not match the connection")
  const temporary = await mkdtemp(join(tmpdir(), "codeg-dsh-side-"))
  const ctx = new Context()
  let parent
  try {
    await boot.composeAgent(ctx, { sessionsRoot: temporary })
    await ctx.plugin(credentials.default, { watch: false })
    await ctx.plugin(deepseek, boot.DEEPSEEK_PROVIDER_CONFIG)
    await ctx.plugin((await load("@deepseek-ai/cordis-plugin-loader")).default, {
      baseUrl: pathToFileURL(join(directory, "lib", "launcher", "boot.js")).href,
    })
    await ctx.plugin(settings.AcpSettings, {})
    if (ctx.acpSettings.mentionsPiAi()) await piAi.ensurePiAi(ctx)
    await ctx.plugin(subagent.default, {})
    await ctx.plugin(fork, {})
    await ctx.plugin(plugin, { readOnlyTools: ["grep", "glob"] })
    const provider = ctx.llm.listProviders()
      .map((entry) => entry.id)
      .sort((left, right) => right.length - left.length)
      .find((id) => request.model.startsWith(`${id}::`))
      ?? process.env.DEEPSEEK_ACP_PROVIDER ?? "deepseek-official"
    const model = request.model.startsWith(`${provider}::`)
      ? request.model.slice(provider.length + 2) : request.model
    const last = stored.events.findLastIndex((event) => event.type === "turn/end")
    const seed = stored.events.slice(0, last + 1)
    parent = await ctx.agents.create({
      sessionId: sessionTypes.SessionId(randomUUID()),
      meta: { cwd: request.cwd, ...(seed.length ? { isSeeded: true } : {}) },
      seed,
      ...(seed.length ? { inheritedEventCount: sessionTypes.SessionLogOffset(seed.length) } : {}),
      agentOptions: { provider, model, ...(request.effort ? { reasoningEffort: request.effort } : {}) },
    })
    const selection = {
      provider, model, ...(request.effort ? { reasoningEffort: request.effort } : {}),
    }
    // fork 只复制闭合回合，子会话创建后再次选择，避免历史 request/header 覆盖当前配置。
    ctx.on("agent/created", ({ agent }) => {
      if (agent.session.header.parentSession === parent.agent.session.id) {
        agent.model.select(selection)
      }
      return undefined
    })
    const command = ctx.commands.find(parent.agent, "btw")
    if (!command || !ctx.subagents.getProvider("fork")?.inheritsParentContext) {
      throw new Error("The DSH Sidechain command is unavailable")
    }
    if (request.operation === "probe") return { supported: true, images: false }
    let settle
    const completed = new Promise((accept) => { settle = accept })
    let ended
    ctx.on("subagent/end", (info) => {
      if (info.parentSessionId === parent.agent.session.id) {
        ended = info
        settle(info)
      }
    })
    const question = request.history?.length
      ? `${request.question}\n\nPrevious side-conversation exchanges (reference only):\n${JSON.stringify(claudeHistory(request.history))}`
      : request.question
    // 直接调用插件命令处理器：command/run 和子会话元数据仅进入临时副本。
    const result = await command.handler({
      agent: parent.agent, rawInput: question, attachments: [],
      signal: new AbortController().signal,
    })
    if (result.kind !== "success") throw new Error("DSH Sidechain could not start the side question")
    const outcome = ended ?? await completed
    if (outcome.stopReason !== "completed") throw new Error("DSH Sidechain did not complete the side question")
    const answer = outcome.lastAssistantMessage?.filter((part) => part.type === "text").map((part) => part.text).join("\n")
    if (!answer?.trim()) throw new Error("DSH Sidechain returned no answer")
    return { answer }
  } finally {
    try {
      await parent?.dispose()
    } finally {
      try {
        await ctx.fiber.dispose()
      } finally {
        await rm(temporary, { recursive: true, force: true })
      }
    }
  }
}

export function versionAtLeast(raw, minimum) {
  const match = raw.match(/\b(\d+)\.(\d+)\.(\d+)\b/)
  if (!match) return false
  const actual = match.slice(1).map(Number)
  return minimum.some((part, index) =>
    actual.slice(0, index).every((value, previous) => value === minimum[previous]) &&
    actual[index] > part
  ) || actual.every((value, index) => value === minimum[index])
}

async function claudeProgram(adapter) {
  if (process.env.CLAUDE_CODE_EXECUTABLE) {
    return process.env.CLAUDE_CODE_EXECUTABLE
  }
  const executable = process.platform === "win32" ? "claude.exe" : "claude"
  if (existsSync(join(dirname(adapter), executable))) {
    return join(dirname(adapter), executable)
  }
  // 使用适配器自己解析的 CLI，避免系统 claude 与当前连接运行不同版本。
  const candidates = [
    dirname(realpathSync(adapter)),
    join(dirname(adapter), "node_modules", "@agentclientprotocol", "claude-agent-acp"),
  ]
  for (const start of candidates) {
    let directory = start
    for (let depth = 0; depth < 6; depth += 1) {
      const helper = join(directory, "dist", "claude-cli.js")
      if (existsSync(helper)) {
        const { claudeCliPath } = await import(pathToFileURL(helper).href)
        return claudeCliPath()
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  throw new Error("The connection's native Claude Code runtime is unavailable")
}

export async function runtimeFor(request) {
  if (request.agent === "pi" && request.program) return piRuntime(request)
  if (request.agent === "deepseek" && request.program) return dshRuntime(request)
  if (request.agent === "codex" && request.program) {
    const javascript = /\.(?:mjs|cjs|js)$/i.test(request.program)
    return {
      program: javascript ? process.execPath : request.program,
      prefix: javascript ? [request.program] : [],
      minimum: [0, 166, 0],
    }
  }
  if (request.agent === "claude_code" && request.program) {
    return {
      program: await claudeProgram(request.program),
      prefix: [],
      minimum: [2, 1, 321],
    }
  }
  throw new Error("This connection has no native side-question bridge")
}

function tomlLiteral(value) {
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value)
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (Array.isArray(value)) return `[${value.map(tomlLiteral).join(", ")}]`
  if (value && typeof value === "object") {
    return `{ ${Object.entries(value).map(([key, item]) =>
      `${JSON.stringify(key)} = ${tomlLiteral(item)}`
    ).join(", ")} }`
  }
  throw new Error("Unsupported native Codex configuration")
}

export function codexConfigArgs(env = process.env) {
  const config = JSON.parse(env.CODEX_CONFIG || "{}")
  if (!config || Array.isArray(config) || typeof config !== "object") {
    throw new Error("Invalid native Codex configuration")
  }
  // CODEX_CONFIG 和 MODEL_PROVIDER 属于 ACP 启动约定，原生 CLI 不会自行读取。
  if (env.MODEL_PROVIDER?.trim()) config.model_provider = env.MODEL_PROVIDER.trim()
  return Object.entries(config).flatMap(([key, value]) => [
    "-c", `${key}=${tomlLiteral(value)}`,
  ])
}

function versionOf(runtime) {
  return new Promise((accept, reject) => {
    execFile(
      runtime.program,
      [...runtime.prefix, "--version"],
      { windowsHide: true, timeout: 10_000, maxBuffer: 16_384 },
      (error, stdout) => error ? reject(error) : accept(stdout)
    )
  })
}

export function createRpc(runtime, args, cwd) {
  const child = spawn(runtime.program, [...runtime.prefix, ...args], {
    cwd,
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  })
  const pending = new Map()
  const listeners = new Set()
  let nextId = 0
  let buffered = ""
  let failure = null
  const fail = () => {
    failure ??= new Error("The native side-question process disconnected")
    for (const waiter of pending.values()) waiter.reject(failure)
    pending.clear()
    for (const listener of listeners) listener({ disconnected: true })
  }
  const write = (message) => {
    if (failure) throw failure
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  child.on("error", fail)
  child.on("exit", fail)
  child.stdin.on("error", fail)
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk) => {
    buffered += chunk
    if (Buffer.byteLength(buffered) > MAX_FRAME_BYTES) {
      fail()
      child.kill()
      return
    }
    let newline
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        fail()
        return
      }
      const control = message.type === "control_response"
      const id = control ? message.response?.request_id : message.id
      const waiter = pending.get(id)
      if (waiter && (control || !message.method)) {
        pending.delete(id)
        if (message.error || (control && message.response?.subtype === "error")) {
          waiter.reject(new Error("The native side-question request failed"))
        } else {
          waiter.resolve(control ? message.response?.response : message.result)
        }
        continue
      }
      if (message.type === "control_request") {
        write({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: { behavior: "deny", message: "Side question only" },
          },
        })
      } else if (message.method && message.id != null) {
        write({
          id: message.id,
          error: { code: -32601, message: "Side question only" },
        })
      } else {
        for (const listener of listeners) listener(message)
      }
    }
  })
  return {
    child,
    write,
    subscribe(listener) {
      if (failure) listener({ disconnected: true })
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    call(method, params, control = false) {
      if (failure) return Promise.reject(failure)
      const id = ++nextId
      return new Promise((accept, reject) => {
        pending.set(control ? String(id) : id, { resolve: accept, reject })
        try {
          write(control
            ? { type: "control_request", request_id: String(id), request: { subtype: method, ...params } }
            : { id, method, params })
        } catch (error) {
          pending.delete(control ? String(id) : id)
          reject(error)
        }
      })
    },
    async close() {
      child.stdin.end()
      if (child.exitCode != null || child.signalCode != null) return
      await Promise.race([
        new Promise((accept) => child.once("exit", accept)),
        new Promise((accept) => {
          const timer = setTimeout(accept, 1_000)
          timer.unref()
        }),
      ])
      if (child.exitCode != null || child.signalCode != null) return
      if (process.platform === "win32") {
        await new Promise((accept) => {
          execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
          }, accept)
        })
      } else {
        child.kill("SIGKILL")
      }
    },
  }
}

export function codexForkParams(request) {
  return {
    threadId: request.sessionId,
    ephemeral: true,
    excludeTurns: true,
    model: request.model,
    cwd: request.cwd,
    approvalPolicy: "never",
    sandbox: "read-only",
    developerInstructions:
      "This is a side conversation. Inherited history is reference only. " +
      "Only answer the user's side question; do not continue the parent task. " +
      "Do not change files or use subagents.",
    config: {
      "features.multi_agent": false,
      "features.multi_agent_v2": false,
      "features.goals": false,
      ...(request.effort ? { model_reasoning_effort: request.effort } : {}),
    },
  }
}

async function askCodex(runtime, request) {
  const rpc = createRpc(runtime, [...codexConfigArgs(), "app-server"], request.cwd)
  try {
    await rpc.call("initialize", {
      clientInfo: { name: "codeg_side_question", version: "1" },
      capabilities: { experimentalApi: true },
    })
    rpc.write({ method: "initialized", params: {} })
    const fork = await rpc.call("thread/fork", codexForkParams(request))
    const threadId = fork?.thread?.id
    if (!threadId || threadId === request.sessionId || fork.thread.ephemeral !== true) {
      throw new Error("Codex did not create an isolated temporary side conversation")
    }
    if (request.history?.length) {
      await rpc.call("thread/inject_items", {
        threadId,
        items: request.history.map((entry) => ({
          type: "message",
          role: entry.role,
          content: [{
            type: entry.role === "assistant" ? "output_text" : "input_text",
            text: entry.text,
          }],
        })),
      })
    }
    const completed = new Promise((accept, reject) => {
      const messages = new Map()
      let unsubscribe = () => {}
      unsubscribe = rpc.subscribe((message) => {
        if (message.disconnected) {
          unsubscribe()
          reject(new Error("Codex disconnected before answering the side question"))
          return
        }
        if (message.params?.threadId !== threadId) return
        const item = message.params.item
        if (message.method === "item/completed" && item?.type === "agentMessage") {
          messages.set(item.id, item.text ?? "")
        }
        if (message.method === "turn/completed") {
          unsubscribe()
          if (message.params.turn?.status !== "completed") {
            reject(new Error("Codex did not complete the side question"))
          } else {
            accept([...messages.values()].join("\n"))
          }
        }
      })
    })
    // 监听先于 turn/start，短回答也不能在 RPC 响应前丢失完成事件。
    const started = rpc.call("turn/start", {
      threadId,
      input: [
        { type: "text", text: request.question },
        ...(request.images ?? []).map((image) => ({
          type: "image",
          url: `data:${image.mime_type};base64,${image.data}`,
        })),
      ],
    })
    const [, answer] = await Promise.all([started, completed])
    return answer
  } finally {
    await rpc.close()
  }
}

export function claudeHistory(entries = []) {
  if (entries.length % 2 !== 0) {
    throw new Error("Invalid native side-question history")
  }
  const history = []
  for (let index = 0; index + 1 < entries.length; index += 2) {
    if (entries[index].role !== "user" || entries[index + 1].role !== "assistant") {
      throw new Error("Invalid native side-question history")
    }
    history.push({ question: entries[index].text, response: entries[index + 1].text })
  }
  return history
}

async function askClaude(runtime, request) {
  if (request.images?.length) {
    throw new Error("Native Claude Code side questions do not accept image attachments")
  }
  const rpc = createRpc(runtime, [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json",
    "--verbose", "--resume", request.sessionId, "--fork-session",
    "--no-session-persistence", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--tools", "", "--permission-prompt-tool", "stdio", "--model", request.model,
    ...(request.effort ? ["--effort", request.effort] : []),
  ], request.cwd)
  try {
    await rpc.call("initialize", { elicitation: {} }, true)
    const history = claudeHistory(request.history)
    const result = await rpc.call("side_question", {
      question: request.question,
      ...(history.length ? { history } : {}),
    }, true)
    if (result?.synthetic || typeof result?.response !== "string") {
      throw new Error("Claude Code did not return a native side-question answer")
    }
    return result.response
  } finally {
    await rpc.close()
  }
}

export async function execute(request) {
  let runtime
  try {
    runtime = await runtimeFor(request)
    if (request.agent === "codex") codexConfigArgs()
    if (!versionAtLeast(runtime.version ?? await versionOf(runtime), runtime.minimum)) {
      throw new Error("The native runtime is too old for verified side questions")
    }
  } catch {
    if (request.operation === "probe") return { supported: false, images: false }
    throw new Error("This connection has no compatible native side-question runtime")
  }
  if (request.agent === "pi" || request.agent === "deepseek") {
    try {
      return await (request.agent === "pi" ? askPi : askDsh)(runtime, request)
    } catch (error) {
      if (request.operation === "probe") return { supported: false, images: false }
      throw error
    }
  }
  if (request.operation === "probe") {
    return { supported: true, images: request.agent === "codex" }
  }
  const answer = request.agent === "codex"
    ? await askCodex(runtime, request)
    : await askClaude(runtime, request)
  if (!answer?.trim()) throw new Error("The native side question returned no answer")
  return { answer }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = createInterface({ input: process.stdin })
  for await (const line of input) {
    try {
      const result = await execute(JSON.parse(line))
      process.stdout.write(`${JSON.stringify(result)}\n`)
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ error: error.message })}\n`)
      process.exitCode = 1
    }
    input.close()
    break
  }
}

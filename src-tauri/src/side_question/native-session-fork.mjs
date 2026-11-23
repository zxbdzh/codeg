import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import { access, readFile, stat } from "node:fs/promises"
import { dirname, extname, isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const SUPPORTED_AGENTS = new Set(["codex", "claude_code", "pi", "deepseek"])
const PI_PACKAGE = "@earendil-works/pi-coding-agent"
const MAX_FRAME_BYTES = 8 * 1024 * 1024
const INITIALIZE_TIMEOUT = 15_000
const FORK_TIMEOUT = 60_000
const CLOSE_GRACE = 2_000
const KILL_GRACE = 1_000

export async function forkNativeSession(request) {
  const input = validateRequest(request)
  if (input.agent === "pi") return forkPi(input)
  return forkAcp(input)
}

function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("A native session fork request is required")
  }
  const agent = requiredText(request.agent, "agent")
  if (!SUPPORTED_AGENTS.has(agent)) {
    throw new Error(`Unsupported native session fork agent: ${agent}`)
  }
  const common = {
    agent,
    cwd: absolutePath(request.cwd, "cwd"),
    sessionId: requiredText(request.sessionId, "sessionId"),
    // 缺少任一字段都无法证明分叉落在已完成的回合上，直接拒绝。
    completedMessageId: requiredText(request.completedMessageId, "completedMessageId"),
    completedFingerprint: requiredText(request.completedFingerprint, "completedFingerprint"),
    completedOccurrence: request.completedOccurrence,
  }
  if (common.completedOccurrence !== undefined &&
      (!Number.isSafeInteger(common.completedOccurrence) || common.completedOccurrence < 1)) {
    throw new Error("completedOccurrence must be a positive integer")
  }
  if (agent === "pi") {
    return {
      ...common,
      piProgram: absolutePath(request.piProgram, "piProgram"),
      piSessionFile: request.piSessionFile === undefined
        ? undefined
        : absolutePath(request.piSessionFile, "piSessionFile"),
    }
  }
  return { ...common, adapterProgram: absolutePath(request.adapterProgram, "adapterProgram") }
}

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`)
  }
  return value.trim()
}

function absolutePath(value, name) {
  const path = requiredText(value, name)
  if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path`)
  return resolve(path)
}

async function requireDirectory(path, name) {
  const info = await stat(path).catch(() => null)
  if (!info?.isDirectory()) throw new Error(`${name} is unavailable`)
}

async function requireFile(path, name) {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw new Error(`${name} is unavailable`)
}

async function forkAcp(input) {
  await requireDirectory(input.cwd, "workspace")
  await access(input.adapterProgram, fsConstants.R_OK).catch(() => {
    throw new Error("The ACP adapter is unavailable")
  })
  const runtime = programCommand(input.adapterProgram)
  const child = spawn(runtime.command, runtime.args, {
    cwd: input.cwd,
    env: process.env,
    windowsHide: true,
    windowsVerbatimArguments: runtime.windowsVerbatimArguments,
    stdio: ["pipe", "pipe", "pipe"],
  })
  const client = createAcpClient(child)
  try {
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "codeg-native-session-fork", version: "1" },
    }, INITIALIZE_TIMEOUT)

    // 独立 ACP 进程只请求 fork，不加载或提示主会话，避免误写父会话。
    const response = await client.request("session/fork", {
      sessionId: input.sessionId,
      cwd: input.cwd,
      mcpServers: [],
      _meta: {
        jetbrains: {
          air: {
            fork: {
              version: 1,
              messageId: input.completedMessageId,
              messageFingerprint: input.completedFingerprint,
              ...(input.completedOccurrence === undefined
                ? {}
                : { messageOccurrence: input.completedOccurrence }),
            },
          },
        },
      },
    }, FORK_TIMEOUT)
    const sessionId = typeof response?.sessionId === "string"
      ? response.sessionId.trim()
      : ""
    if (!sessionId) {
      throw new Error("The ACP adapter did not return a forked session id")
    }
    if (sessionId === input.sessionId) {
      throw new Error("The ACP adapter did not create an independent forked session")
    }
    return { sessionId }
  } finally {
    // 返回前确保子进程退出；否则调用方会误以为分支已经完全落盘。
    await client.close()
  }
}

function programCommand(program) {
  const extension = extname(program).toLowerCase()
  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    return { command: process.execPath, args: [program] }
  }
  if (process.platform === "win32" && [".cmd", ".bat"].includes(extension)) {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      // /s 会移除命令串首尾引号；保留双层引号才能安全承载带空格的 shim 路径。
      args: ["/d", "/s", "/c", `""${program}""`],
      windowsVerbatimArguments: true,
    }
  }
  return { command: program, args: [] }
}

function createAcpClient(child) {
  const pending = new Map()
  let nextId = 0
  let buffered = ""
  let failure = null
  let closed = false

  const exitPromise = new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) resolveExit()
    else child.once("exit", resolveExit)
  })

  const fail = (message) => {
    if (failure) return
    failure = new Error(message)
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(failure)
    }
    pending.clear()
  }

  const write = (message) => {
    if (failure) throw failure
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  const handleMessage = (message) => {
    if (!message || typeof message !== "object") return
    if (message.method && message.id !== undefined) {
      // ACP 客户端能力已声明关闭，服务端反向请求统一拒绝，避免挂住分叉流程。
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Unsupported client request" },
      })
      return
    }
    if (message.method || message.id === undefined) return
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error) {
      const detail = typeof message.error.message === "string"
        ? message.error.message
        : "ACP request failed"
      waiter.reject(new Error(detail))
    } else {
      waiter.resolve(message.result)
    }
  }

  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk) => {
    if (failure) return
    buffered += chunk
    if (Buffer.byteLength(buffered) > MAX_FRAME_BYTES) {
      fail("The ACP adapter response is too large")
      child.kill()
      return
    }
    let newline
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, newline).trim()
      buffered = buffered.slice(newline + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        fail("The ACP adapter returned an invalid message")
        return
      }
      handleMessage(message)
    }
  })
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", () => {})
  child.on("error", () => fail("The ACP adapter process failed"))
  child.stdin.on("error", () => fail("The ACP adapter input disconnected"))
  child.on("exit", () => {
    fail("The ACP adapter disconnected before the session fork completed")
  })

  const request = (method, params, timeout) => {
    if (failure) return Promise.reject(failure)
    const id = ++nextId
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectRequest(new Error(`${method} timed out after ${timeout} ms`))
      }, timeout)
      timer.unref?.()
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer })
      try {
        write({ jsonrpc: "2.0", id, method, params })
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        rejectRequest(error)
      }
    })
  }

  const close = async () => {
    if (closed) return
    closed = true
    try {
      child.stdin.end()
    } catch {
      // 输入已断开时继续等待退出。
    }
    const exited = await Promise.race([
      exitPromise.then(() => true),
      delay(CLOSE_GRACE).then(() => false),
    ])
    if (exited || child.exitCode !== null || child.signalCode !== null) return
    killTree(child)
    await Promise.race([exitPromise, delay(KILL_GRACE)])
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill()
      } catch {
        // 已尽力回收，不掩盖创建分支时的真实错误。
      }
      await Promise.race([exitPromise, delay(250)])
    }
  }

  return { request, close }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function killTree(child) {
  if (!child.pid) return
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    })
    return
  }
  try {
    child.kill("SIGKILL")
  } catch {
    // 进程可能刚好自行退出。
  }
}

async function forkPi(input) {
  await requireDirectory(input.cwd, "workspace")
  const sdk = await loadPiSdk(input.piProgram)
  const sessionFile = await findPiSessionFile(sdk.SessionManager, input)
  await requireFile(sessionFile, "Pi session file")

  const parentBefore = await readFile(sessionFile)
  const parentHeader = parsePiHeader(parentBefore)
  if (parentHeader.id !== input.sessionId) {
    throw new Error("Pi session identity does not match the request")
  }
  const manager = sdk.SessionManager.open(sessionFile, dirname(sessionFile))
  const parentBranch = manager.getBranch()
  const completed = parentBranch.find((entry) =>
    entry?.id === input.completedMessageId &&
    entry?.type === "message" &&
    entry.message?.role === "assistant" &&
    entry.message.stopReason === "stop"
  )
  // 以请求时确定的回合为准，主会话可以在建立分支期间继续推进。
  if (!completed?.id) {
    throw new Error("The requested Pi fork point is not the last completed assistant turn")
  }
  verifyPiFingerprint(completed.message, input.completedFingerprint)

  const cutIndex = parentBranch.findIndex((entry) => entry.id === completed.id)
  const laterIds = new Set(parentBranch.slice(cutIndex + 1).map((entry) => entry.id))
  const branchFile = manager.createBranchedSession(completed.id)
  if (typeof branchFile !== "string" || !branchFile.trim()) {
    throw new Error("Pi did not return a persistent forked session file")
  }
  const absoluteBranchFile = isAbsolute(branchFile)
    ? resolve(branchFile)
    : resolve(dirname(sessionFile), branchFile)
  await requireFile(absoluteBranchFile, "Pi forked session file")
  const branch = sdk.SessionManager.open(absoluteBranchFile, dirname(absoluteBranchFile))
  const branchEntries = branch.getBranch()
  const branchSessionId = branch.getSessionId()
  if (typeof branchSessionId !== "string" || !branchSessionId.trim() ||
      branchSessionId === input.sessionId) {
    throw new Error("Pi did not create an independent forked session")
  }
  if (!branchEntries.some((entry) => entry.id === completed.id)) {
    throw new Error("Pi fork does not contain the completed assistant turn")
  }
  if (branchEntries.some((entry) => laterIds.has(entry.id))) {
    throw new Error("Pi fork contains an in-progress turn")
  }

  // 主任务可继续追加记录，但建分支不能改写原有记录。
  const parentAfter = await readFile(sessionFile)
  if (!parentAfter.subarray(0, parentBefore.length).equals(parentBefore)) {
    throw new Error("Pi parent session changed while creating the fork")
  }
  return { sessionId: branchSessionId.trim(), sessionFile: absoluteBranchFile }
}

async function loadPiSdk(program) {
  const packageRoot = await findPiPackage(program)
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
  if (manifest.name !== PI_PACKAGE) throw new Error("The Pi SDK is unavailable")
  for (const candidate of [
    join(packageRoot, "dist", "core", "session-manager.js"),
    join(packageRoot, "dist", "index.js"),
  ]) {
    const info = await stat(candidate).catch(() => null)
    if (!info?.isFile()) continue
    const module = await import(pathToFileURL(candidate).href)
    const SessionManager = module.SessionManager
    if (!SessionManager || typeof SessionManager.findById !== "function" ||
        typeof SessionManager.open !== "function") {
      throw new Error("The Pi SDK has no usable SessionManager")
    }
    return { SessionManager }
  }
  throw new Error("The Pi SDK has no usable SessionManager")
}

async function findPiPackage(program) {
  const info = await stat(program).catch(() => null)
  if (!info) throw new Error("The Pi SDK is unavailable")
  let directory = info.isDirectory() ? program : dirname(program)
  for (let depth = 0; depth < 8; depth += 1) {
    for (const candidate of [
      directory,
      join(directory, "node_modules", "@earendil-works", "pi-coding-agent"),
      join(directory, "@earendil-works", "pi-coding-agent"),
    ]) {
      try {
        const manifest = JSON.parse(await readFile(join(candidate, "package.json"), "utf8"))
        if (manifest.name === PI_PACKAGE) return candidate
      } catch {
        // 继续检查上一层安装目录。
      }
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error("The Pi SDK is unavailable")
}

async function findPiSessionFile(SessionManager, input) {
  if (input.piSessionFile) return input.piSessionFile
  const found = await SessionManager.findById(input.cwd, input.sessionId)
  const file = typeof found === "string"
    ? found
    : found?.sessionFile ?? found?.file
  if (typeof file !== "string" || !file.trim()) {
    throw new Error("The current native Pi session is unavailable")
  }
  return resolve(file)
}

function parsePiHeader(content) {
  const first = content.toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0]
  let header
  try {
    header = JSON.parse(first)
  } catch {
    throw new Error("Pi session file is invalid")
  }
  if (header?.type !== "session" || typeof header.id !== "string") {
    throw new Error("Pi session file has no session header")
  }
  return header
}

function assistantText(message) {
  if (typeof message.text === "string") return message.text
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return null
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
}

function verifyPiFingerprint(message, fingerprint) {
  const match = /^sha256:([0-9a-f]{64})$/i.exec(fingerprint)
  if (!match) throw new Error("Pi session fingerprint is not a sha256 digest")
  const text = assistantText(message)
  if (text === null) throw new Error("Pi session fingerprint cannot be verified")
  const actual = createHash("sha256").update(text).digest("hex")
  if (actual !== match[1].toLowerCase()) {
    throw new Error("Pi session fingerprint does not match the completed turn")
  }
}

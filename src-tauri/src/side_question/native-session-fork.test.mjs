import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"

import { forkNativeSession } from "./native-session-fork.mjs"

const PI_PACKAGE = "@earendil-works/pi-coding-agent"

function fingerprint(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`
}

async function writeMockAdapter(directory) {
  const program = join(directory, "mock-acp.mjs")
  const log = join(directory, "requests.jsonl")
  await writeFile(program, `
    import { appendFileSync } from "node:fs"
    import { createInterface } from "node:readline"

    const log = ${JSON.stringify(log)}
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n")

    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line)
      appendFileSync(log, JSON.stringify(request) + "\\n")
      if (request.method === "initialize") {
        send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1 } })
        continue
      }
      if (request.method === "session/fork") {
        if (request.params.sessionId === "same-parent") {
          send({ jsonrpc: "2.0", id: request.id, result: { sessionId: "same-parent" } })
          continue
        }
        if (request.params.sessionId === "missing-child") {
          send({ jsonrpc: "2.0", id: request.id, result: {} })
          continue
        }
        if (request.params.sessionId === "adapter-exits") process.exit(0)
        send({
          jsonrpc: "2.0",
          id: request.id,
          result: { sessionId: "child-" + request.params.sessionId },
        })
        continue
      }
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "unexpected method" },
      })
    }
    appendFileSync(log, JSON.stringify({ closed: true }) + "\\n")
  `)
  return { program, log }
}

function acpRequest(adapterProgram, cwd, overrides = {}) {
  return {
    agent: "codex",
    adapterProgram,
    cwd,
    sessionId: "parent",
    completedMessageId: "message-1",
    completedFingerprint: fingerprint("completed answer"),
    ...overrides,
  }
}

async function readJsonLines(file) {
  return (await readFile(file, "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test("ACP fork sends the explicit completed turn and releases the child before returning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codeg-native-fork-"))
  try {
    const { program, log } = await writeMockAdapter(directory)
    const completedFingerprint = fingerprint("completed answer")
    const result = await forkNativeSession(acpRequest(program, directory, {
      completedMessageId: "completed-message",
      completedFingerprint,
      completedOccurrence: 2,
    }))
    assert.deepEqual(result, { sessionId: "child-parent" })

    const requests = await readJsonLines(log)
    const methods = requests.filter((request) => request.method).map((request) => request.method)
    assert.deepEqual(methods, ["initialize", "session/fork"])
    const fork = requests.find((request) => request.method === "session/fork")
    assert.equal(fork.params.sessionId, "parent")
    assert.equal(fork.params.cwd, directory)
    assert.deepEqual(fork.params.mcpServers, [])
    assert.deepEqual(fork.params._meta, {
      jetbrains: {
        air: {
          fork: {
            version: 1,
            messageId: "completed-message",
            messageFingerprint: completedFingerprint,
            messageOccurrence: 2,
          },
        },
      },
    })
    assert.equal(requests.some((request) =>
      request.method === "session/prompt" || request.method === "session/load"
    ), false)
    // 关闭标记在返回后才可读，证明驱动没有提前释放调用方。
    assert.equal(requests.at(-1).closed, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("ACP fork accepts codex, claude_code and deepseek", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codeg-native-fork-agents-"))
  try {
    const { program } = await writeMockAdapter(directory)
    for (const agent of ["codex", "claude_code", "deepseek"]) {
      const result = await forkNativeSession(acpRequest(program, directory, { agent }))
      assert.deepEqual(result, { sessionId: "child-parent" })
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("ACP fork fails closed without an independent fork point", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codeg-native-fork-fail-"))
  try {
    const { program } = await writeMockAdapter(directory)
    await assert.rejects(
      forkNativeSession(acpRequest(program, directory, { sessionId: "same-parent" })),
      /independent/,
    )
    await assert.rejects(
      forkNativeSession(acpRequest(program, directory, { sessionId: "missing-child" })),
      /forked session id/,
    )
    await assert.rejects(
      forkNativeSession(acpRequest(program, directory, { sessionId: "adapter-exits" })),
      /disconnected/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("request validation rejects missing fork evidence and implicit paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codeg-native-fork-input-"))
  try {
    const { program } = await writeMockAdapter(directory)
    await assert.rejects(
      forkNativeSession(acpRequest(program, directory, { completedMessageId: "" })),
      /completedMessageId/,
    )
    await assert.rejects(
      forkNativeSession(acpRequest(program, directory, { completedFingerprint: " " })),
      /completedFingerprint/,
    )
    await assert.rejects(
      forkNativeSession(acpRequest(program, directory, { agent: "gemini" })),
      /Unsupported/,
    )
    await assert.rejects(
      forkNativeSession(acpRequest("mock-acp.mjs", directory)),
      /absolute/,
    )
    await assert.rejects(
      forkNativeSession(acpRequest(program, "relative-workspace")),
      /absolute/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

async function createPiFixture(directory, appendDuringFork = false) {
  const packageRoot = join(directory, "node_modules", "@earendil-works", "pi-coding-agent")
  const sdkDirectory = join(packageRoot, "dist", "core")
  await mkdir(sdkDirectory, { recursive: true })
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: PI_PACKAGE,
    version: "1.0.0",
  }))
  const program = join(packageRoot, "dist", "cli.js")
  await writeFile(program, "")

  const sessions = join(directory, "pi", "sessions")
  await mkdir(sessions, { recursive: true })
  const parentFile = join(sessions, "parent.jsonl")
  const entries = [
    { type: "session", id: "parent", cwd: directory },
    {
      id: "user-1",
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "parent question" }] },
    },
    {
      id: "completed-assistant",
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "completed answer" }],
        stopReason: "stop",
      },
    },
    {
      id: "pending-user",
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "in progress" }] },
    },
    {
      id: "pending-assistant",
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "unfinished answer" }],
        stopReason: "toolUse",
      },
    },
  ]
  await writeFile(parentFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n")

  await writeFile(join(sdkDirectory, "session-manager.js"), `
    import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
    import { dirname, join } from "node:path"

    const parentFile = ${JSON.stringify(parentFile)}

    class SessionManager {
      static findById(cwd, sessionId) {
        return sessionId === "parent" ? parentFile : null
      }

      static open(file) {
        return new SessionManager(file)
      }

      constructor(file) {
        this.file = file
      }

      read() {
        return readFileSync(this.file, "utf8")
          .split(/\\r?\\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      }

      getBranch() {
        return this.read().slice(1)
      }

      getSessionId() {
        return this.read()[0].id
      }

      getSessionFile() {
        return this.file
      }

      createBranchedSession(leafId) {
        const entries = this.read()
        const index = entries.findIndex((entry) => entry.id === leafId)
        if (index < 0) throw new Error("missing branch leaf")
        const id = "branch-" + Date.now() + "-" + Math.random().toString(16).slice(2)
        const file = join(dirname(this.file), id + ".jsonl")
        const branch = [{ ...entries[0], id }, ...entries.slice(1, index + 1)]
        writeFileSync(file, branch.map((entry) => JSON.stringify(entry)).join("\\n") + "\\n")
        if (${JSON.stringify(appendDuringFork)}) {
          appendFileSync(this.file, JSON.stringify({ id: "parent-advanced" }) + "\\n")
        }
        return file
      }
    }

    export { SessionManager }
  `)
  return { program, parentFile }
}

function piRequest(piProgram, cwd, overrides = {}) {
  return {
    agent: "pi",
    piProgram,
    cwd,
    sessionId: "parent",
    completedMessageId: "completed-assistant",
    completedFingerprint: fingerprint("completed answer"),
    ...overrides,
  }
}

test("Pi fork creates a persistent branch at the last completed assistant turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codeg-pi-fork-"))
  try {
    const { program, parentFile } = await createPiFixture(directory)
    const parentBefore = await readFile(parentFile, "utf8")
    const result = await forkNativeSession(piRequest(program, directory))

    assert.match(result.sessionId, /^branch-/)
    assert.notEqual(result.sessionId, "parent")
    assert.equal(typeof result.sessionFile, "string")
    assert.notEqual(result.sessionFile, parentFile)
    const branch = await readJsonLines(result.sessionFile)
    assert.equal(branch[0].id, result.sessionId)
    assert.ok(branch.some((entry) => entry.id === "completed-assistant"))
    assert.equal(branch.some((entry) => entry.id === "pending-user"), false)
    assert.equal(branch.some((entry) => entry.id === "pending-assistant"), false)
    assert.equal(await readFile(parentFile, "utf8"), parentBefore)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Pi keeps the requested completed boundary if the parent advances before the fork", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codeg-pi-fork-advanced-"))
  try {
    const { program, parentFile } = await createPiFixture(directory)
    await appendFile(parentFile, JSON.stringify({
      id: "later-completed",
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "later answer" }],
        stopReason: "stop",
      },
    }) + "\n")

    const result = await forkNativeSession(piRequest(program, directory))
    const branch = await readJsonLines(result.sessionFile)
    assert.ok(branch.some((entry) => entry.id === "completed-assistant"))
    assert.equal(branch.some((entry) => entry.id === "later-completed"), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Pi allows the parent to append while the independent branch is created", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codeg-pi-fork-concurrent-"))
  try {
    const { program, parentFile } = await createPiFixture(directory, true)
    const result = await forkNativeSession(piRequest(program, directory))
    const branch = await readJsonLines(result.sessionFile)
    const parent = await readJsonLines(parentFile)
    assert.ok(parent.some((entry) => entry.id === "parent-advanced"))
    assert.equal(branch.some((entry) => entry.id === "parent-advanced"), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Pi fork rejects an unverifiable fingerprint or an in-progress turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codeg-pi-fork-fail-"))
  try {
    const { program, parentFile } = await createPiFixture(directory)
    const parentBefore = await readFile(parentFile, "utf8")
    await assert.rejects(
      forkNativeSession(piRequest(program, directory, {
        completedFingerprint: fingerprint("wrong answer"),
      })),
      /fingerprint/,
    )
    await assert.rejects(
      forkNativeSession(piRequest(program, directory, {
        completedMessageId: "pending-assistant",
        completedFingerprint: fingerprint("unfinished answer"),
      })),
      /last completed/,
    )
    await assert.rejects(
      forkNativeSession(piRequest(program, directory, {
        completedFingerprint: "opaque-value",
      })),
      /sha256/,
    )
    assert.equal(await readFile(parentFile, "utf8"), parentBefore)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Pi fork fails when the explicit install has no SDK", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codeg-pi-fork-missing-"))
  try {
    const program = join(directory, "bin", "pi.mjs")
    await mkdir(dirname(program), { recursive: true })
    await writeFile(program, "")
    await assert.rejects(
      forkNativeSession(piRequest(program, directory)),
      /Pi SDK is unavailable/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

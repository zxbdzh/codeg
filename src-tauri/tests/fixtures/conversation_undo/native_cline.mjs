import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const [sdkPath, action, dataDir, workspace, sessionId] = process.argv.slice(1)
if (!sdkPath || !action || !dataDir || !workspace || !sessionId) {
  throw new Error(
    "expected SDK module, action, data directory, workspace, and session id"
  )
}

const sdk = await import(pathToFileURL(path.resolve(sdkPath)).href)
const dbDir = path.join(dataDir, "db")
const sessionsDir = path.join(dataDir, "sessions")
fs.mkdirSync(workspace, { recursive: true })

const openStore = () => {
  const store = new sdk.SqliteSessionStore({ sessionsDir: dbDir })
  store.init()
  return store
}

if (action === "seed") {
  const store = openStore()
  try {
    const service = new sdk.CoreSessionService(store, {
      sessionArtifactsDir: sessionsDir,
    })
    const startedAt = "2026-11-18T00:00:00.000Z"
    await service.createRootSessionWithArtifacts({
      sessionId,
      source: "cli",
      pid: 0,
      interactive: true,
      provider: "synthetic",
      model: "offline-test",
      cwd: workspace,
      workspaceRoot: workspace,
      enableTools: false,
      enableSpawn: false,
      enableTeams: false,
      prompt: "Keep this prompt",
      status: "completed",
      startedAt,
      endedAt: startedAt,
      exitCode: 0,
    })
    const baseTs = Date.parse(startedAt)
    await service.persistSessionMessages(sessionId, [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: '<user_input mode="act">Keep this prompt</user_input>',
          },
        ],
        ts: baseTs,
        metadata: {},
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Kept answer" }],
        ts: baseTs + 1,
        metadata: {},
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: '<user_input mode="act">  Keep  exact input\n </user_input>',
          },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "b3JpZ2luYWw=",
            },
          },
        ],
        ts: baseTs + 2,
        metadata: {},
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Undo this answer" }],
        ts: baseTs + 3,
        metadata: {},
      },
    ])
    console.log(JSON.stringify({ sessionId, seeded: true }))
  } finally {
    store.close()
  }
} else if (action === "read" || action === "resave") {
  const store = openStore()
  try {
    const service = new sdk.CoreSessionService(store, {
      sessionArtifactsDir: sessionsDir,
    })
    const host = new sdk.LocalRuntimeHost({ sessionService: service })
    const messages = await host.readSessionMessages(sessionId)
    if (action === "resave") {
      await service.persistSessionMessages(sessionId, messages)
    }
    console.log(JSON.stringify({ sessionId, messages }))
  } finally {
    store.close()
  }
} else {
  throw new Error(`unknown action: ${action}`)
}

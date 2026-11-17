import { pathToFileURL } from "node:url"
const [modules, root, sessionId] = process.argv.slice(1)
const { Context } = await import(pathToFileURL(`${modules}/@deepseek-ai/cordis/lib/index.js`))
const { default: JsonlPersistence } = await import(pathToFileURL(`${modules}/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`))
const { Session } = await import(pathToFileURL(`${modules}/@deepseek-ai/dsh-session/lib/index.js`))
const context = new Context()
const plugin = await context.plugin(JsonlPersistence, { root, compression: "zstd" })
try {
  const handle = await context.sessionPersistence.open(sessionId, "read")
  const restored = await handle.read()
  const session = Session.fromRestore(sessionId, restored.events, handle.header, handle.inheritedEventCount, restored.eventState)
  const users = session.snapshotEvents()
    .filter(event => event.type === "user/message" && event.data.source?.kind === "user")
    .map(event => event.data.id)
  console.log(JSON.stringify({ id: session.header.id, users }))
  await handle.close()
} finally {
  await plugin.dispose()
}

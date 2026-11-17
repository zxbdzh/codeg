import { pathToFileURL } from "node:url"
import { dirname } from "node:path"
const [modules, root, sessionId, action = "read"] = process.argv.slice(1)
const { Context } = await import(
  pathToFileURL(`${modules}/@deepseek-ai/cordis/lib/index.js`)
)
const { default: JsonlPersistence } = await import(
  pathToFileURL(
    `${modules}/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`
  )
)
const { Session } = await import(
  pathToFileURL(`${modules}/@deepseek-ai/dsh-session/lib/index.js`)
)
const context = new Context()
const plugin = await context.plugin(JsonlPersistence, {
  root,
  compression: "zstd",
})
try {
  const handle = await context.sessionPersistence.open(
    sessionId,
    action === "hold-writer" ? "write" : "read"
  )
  if (action === "hold-writer") {
    console.log(JSON.stringify({ id: sessionId, writer: true }))
    await new Promise((resolve) => process.stdin.once("data", resolve))
    process.stdin.pause()
    await handle.close()
  } else {
    const restored = await handle.read()
    const session = Session.fromRestore(
      sessionId,
      restored.events,
      handle.header,
      handle.inheritedEventCount,
      restored.eventState
    )
    const users = session
      .snapshotEvents()
      .filter(
        (event) =>
          event.type === "user/message" && event.data.source?.kind === "user"
      )
      .map((event) => event.data.id)
    if (action === "read-media") {
      const { default: LocalAttachments } = await import(
        pathToFileURL(
          `${modules}/@deepseek-ai/dsh-attachment-local/lib/index.js`
        )
      )
      const attachments = await context.plugin(LocalAttachments, {
        dshHome: dirname(root),
      })
      try {
        const inputs = []
        for (const event of session.snapshotEvents()) {
          if (
            event.type !== "user/message" ||
            event.data.source?.kind !== "user"
          )
            continue
          const parts = []
          for (const part of event.data.content) {
            if (part.type === "image") {
              const stored = await context.attachments.readImage(
                part.attachment
              )
              parts.push({
                type: "image",
                data: Buffer.from(stored.data).toString("base64"),
              })
            } else if (part.type === "file") {
              const chunks = []
              for await (const chunk of context.attachments.readFileStream(
                part.attachment
              ))
                chunks.push(Buffer.from(chunk))
              parts.push({
                type: "file",
                name: part.attachment.name,
                data: Buffer.concat(chunks).toString("base64"),
              })
            } else {
              parts.push(part)
            }
          }
          inputs.push({ id: event.data.id, parts })
        }
        console.log(JSON.stringify({ id: session.header.id, users, inputs }))
      } finally {
        await attachments.dispose()
      }
    } else {
      console.log(JSON.stringify({ id: session.header.id, users }))
    }
    await handle.close()
  }
} finally {
  await plugin.dispose()
}

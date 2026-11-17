import { pathToFileURL } from "node:url"
const [modulePath, sessionId] = process.argv.slice(1)
const { getSessionMessages } = await import(pathToFileURL(modulePath))
const messages = await getSessionMessages(sessionId)
console.log(JSON.stringify({
  messages: messages.map(message => ({
    id: message.uuid,
    role: message.type,
  })),
}))

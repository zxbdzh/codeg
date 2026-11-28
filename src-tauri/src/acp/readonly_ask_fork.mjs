import { pathToFileURL } from "node:url"

const { sdkPath, sourceId, anchor } = JSON.parse(process.argv[1])
const { forkSession, getSessionMessages } = await import(
  pathToFileURL(sdkPath).href
)
const identity = (entry) => [
  entry.type,
  entry.message,
  entry.parent_tool_use_id,
  entry.parent_agent_id,
]
const options = { includeSystemMessages: true }
const source = await getSessionMessages(sourceId, options)
const index = source.findIndex((entry) => entry.uuid === anchor)
if (
  index < 0 ||
  source[index].type !== "assistant" ||
  source[index].message?.stop_reason !== "end_turn"
) {
  throw new Error(
    "The completed Claude turn is no longer the source's active history"
  )
}
const branch = await forkSession(sourceId, { upToMessageId: anchor })
const forked = await getSessionMessages(branch.sessionId, options)
// 对比原生消息内容（含工具结果），忽略 fork 有意重写的外层会话和消息 UUID。
if (
  branch.sessionId === sourceId ||
  JSON.stringify(forked.map(identity)) !==
    JSON.stringify(source.slice(0, index + 1).map(identity))
) {
  throw new Error(
    "Claude did not preserve the completed native context exactly"
  )
}
process.stdout.write(branch.sessionId)

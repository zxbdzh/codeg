import { createInterface } from "node:readline"
import { DatabaseSync } from "node:sqlite"
import path from "node:path"

const endpoint =
  process.env.CODEG_WEB_BROWSER_AGENT_URL || "http://127.0.0.1:3195/mcp"
const parsed = new URL(endpoint)
if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1")
  throw new Error("Browser MCP must use its local loopback service")
const database =
  process.env.CODEG_WEB_BROWSER_DATABASE ||
  path.join(process.env.APPDATA, "app.codeg", "codeg.db")
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of input) {
  if (!line.trim()) continue
  let request
  try {
    request = JSON.parse(line)
    if (!Object.hasOwn(request, "id")) continue
    const db = new DatabaseSync(database, { readOnly: true })
    let token
    try {
      token = db
        .prepare(
          "SELECT value FROM app_metadata WHERE key = ? AND deleted_at IS NULL"
        )
        .get("web_service_token")?.value
    } finally {
      db.close()
    }
    if (!token) throw new Error("Codeg Web service is not configured")
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(150000),
      redirect: "error",
    })
    if (!response.ok)
      throw new Error(`Browser service returned HTTP ${response.status}`)
    process.stdout.write(`${JSON.stringify(await response.json())}\n`)
  } catch (error) {
    if (request && Object.hasOwn(request, "id"))
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error.message } })}\n`
      )
  }
}

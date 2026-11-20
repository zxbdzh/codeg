import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"

test(
  "stdio MCP reads the configured local token without returning it to the agent",
  { timeout: 10000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codeg-browser-mcp-"))
    const database = path.join(directory, "codeg.db")
    const db = new DatabaseSync(database)
    db.exec("CREATE TABLE app_metadata (key TEXT, value TEXT, deleted_at TEXT)")
    db.prepare("INSERT INTO app_metadata VALUES (?, ?, NULL)").run(
      "web_service_token",
      "synthetic-local-token"
    )
    db.close()
    const requests = []
    const server = createServer(async (request, response) => {
      assert.equal(request.url, "/mcp")
      assert.equal(
        request.headers.authorization,
        "Bearer synthetic-local-token"
      )
      let body = ""
      for await (const chunk of request) body += chunk
      const rpc = JSON.parse(body)
      requests.push(rpc)
      response.setHeader("Content-Type", "application/json")
      response.end(
        JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { tools: [] } })
      )
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const child = spawn(process.execPath, ["scripts/web-browser-mcp.mjs"], {
      env: {
        ...process.env,
        CODEG_WEB_BROWSER_DATABASE: database,
        CODEG_WEB_BROWSER_AGENT_URL: `http://127.0.0.1:${server.address().port}/mcp`,
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let output = ""
    let diagnostics = ""
    child.stdout.on("data", (chunk) => {
      output += chunk
    })
    child.stderr.on("data", (chunk) => {
      diagnostics += chunk
    })
    try {
      const exited = new Promise((resolve, reject) => {
        child.once("error", reject)
        child.once("exit", resolve)
      })
      child.stdin.end(
        '{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n'
      )
      assert.equal(await exited, 0, diagnostics)
      assert.equal(requests.length, 1)
      assert.equal(requests[0].method, "tools/list")
      assert.deepEqual(JSON.parse(output), {
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [] },
      })
      assert.ok(!output.includes("synthetic-local-token"))
      assert.ok(!diagnostics.includes("synthetic-local-token"))
    } finally {
      child.kill()
      await new Promise((resolve) => server.close(resolve))
    }
  }
)

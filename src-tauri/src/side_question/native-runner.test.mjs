import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  claudeHistory,
  codexConfigArgs,
  codexForkParams,
  execute,
  versionAtLeast,
} from "./native-runner.mjs"

test("native version checks fail closed for old or unrecognized runtimes", () => {
  assert.equal(versionAtLeast("codex-cli 0.166.0", [0, 166, 0]), true)
  assert.equal(versionAtLeast("0.165.9", [0, 166, 0]), false)
  assert.equal(versionAtLeast("2.1.321 (Claude Code)", [2, 1, 321]), true)
  assert.equal(versionAtLeast("unknown", [0, 166, 0]), false)
})

test("native fork keeps the parent identity and uses an ephemeral read-only child", () => {
  const params = codexForkParams({
    sessionId: "parent",
    model: "native-model",
    cwd: "/workspace",
    effort: "high",
  })
  assert.equal(params.threadId, "parent")
  assert.equal(params.ephemeral, true)
  assert.equal(params.excludeTurns, true)
  assert.equal(params.sandbox, "read-only")
  assert.equal(params.config.model_reasoning_effort, "high")
  assert.equal(Object.hasOwn(params, "history"), false)
})

test("Claude follow-ups use the native history format", () => {
  assert.deepEqual(claudeHistory([
    { role: "user", text: "first question" },
    { role: "assistant", text: "first answer" },
  ]), [{ question: "first question", response: "first answer" }])
  assert.throws(() => claudeHistory([
    { role: "assistant", text: "forged history" },
    { role: "user", text: "bad order" },
  ]))
})

test("Codex keeps ACP provider overrides when starting its native runtime", () => {
  const args = codexConfigArgs({
    CODEX_CONFIG: JSON.stringify({
      model_provider: "original",
      "model_providers.gateway": {
        base_url: "http://127.0.0.1:12345/v1",
        requires_openai_auth: false,
      },
    }),
    MODEL_PROVIDER: "gateway",
  })
  assert.ok(args.includes('model_provider="gateway"'))
  assert.ok(args.some((value) => value.includes('"base_url" = "http://127.0.0.1:12345/v1"')))
  assert.ok(args.some((value) => value.includes('"requires_openai_auth" = false')))
  assert.throws(() => codexConfigArgs({ CODEX_CONFIG: "[]" }))
})

test("plugins without a callable native bridge are not advertised", async () => {
  for (const agent of ["pi", "deepseek"]) {
    assert.deepEqual(await execute({ operation: "probe", agent }), {
      supported: false,
      images: false,
    })
  }
})

test("native Codex requests fork rather than resume the parent and route only child events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codeg-native-side-"))
  const program = join(directory, "codex.mjs")
  const log = join(directory, "requests.jsonl")
  await writeFile(program, `
    import { createInterface } from "node:readline";
    import { appendFileSync } from "node:fs";
    if (process.argv.includes("--version")) {
      console.log("codex-cli 0.166.0");
      process.exit(0);
    }
    const send = (value) => console.log(JSON.stringify(value));
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      appendFileSync(${JSON.stringify(log)}, line + "\\n");
      if (request.method === "initialize") send({ id: request.id, result: {} });
      if (request.method === "thread/fork") {
        if (request.params.threadId === "invalid-parent") {
          send({ id: request.id, result: { thread: { id: "invalid-parent", ephemeral: true } } });
          continue;
        }
        if (request.params.threadId === "disconnect") process.exit(0);
        send({ id: request.id, result: { thread: { id: "child", ephemeral: true } } });
      }
      if (request.method === "thread/inject_items") send({ id: request.id, result: {} });
      if (request.method === "turn/start") {
        send({ method: "item/completed", params: {
          threadId: "parent", item: { type: "agentMessage", id: "wrong", text: "parent output" }
        } });
        send({ method: "item/completed", params: {
          threadId: "child", item: { type: "agentMessage", id: "answer", text: "native answer" }
        } });
        send({ method: "turn/completed", params: {
          threadId: "child", turn: { status: "completed" }
        } });
        send({ id: request.id, result: { turn: { id: "turn" } } });
      }
    }
  `)
  try {
    const result = await execute({
      agent: "codex",
      program,
      cwd: directory,
      sessionId: "parent",
      model: "native-model",
      question: "side question",
      history: [
        { role: "user", text: "previous question" },
        { role: "assistant", text: "previous answer" },
      ],
    })
    assert.equal(result.answer, "native answer")
    await assert.rejects(execute({
      agent: "codex", program, cwd: directory,
      sessionId: "invalid-parent", question: "must not touch parent",
    }), /isolated temporary/)
    await assert.rejects(execute({
      agent: "codex", program, cwd: directory,
      sessionId: "disconnect", question: "must fail on disconnect",
    }), /disconnected/)
    const requests = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse)
    assert.equal(requests.some((request) => request.method === "thread/resume"), false)
    assert.equal(requests.find((request) => request.method === "thread/fork").params.threadId, "parent")
    assert.equal(requests.find((request) => request.method === "turn/start").params.threadId, "child")
    assert.equal(requests.filter((request) => request.method === "turn/start").length, 1)
    assert.equal(requests.find((request) => request.method === "thread/inject_items").params.items[1].role, "assistant")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

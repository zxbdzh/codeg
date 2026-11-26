// @vitest-environment node

import { readFile } from "node:fs/promises"
import vm from "node:vm"
import assert from "node:assert/strict"
import { test } from "vitest"

const path = new URL(
  "../../../src-tauri/src/browser/ego_session_source.js",
  import.meta.url
)

test("a missing bound Ego profile is refused instead of using another account", async () => {
  const script = await readFile(path, "utf8")
  const output: string[] = []
  await vm.runInNewContext(`(async()=>{${script}})()`, {
    request: {
      mode: "read",
      profileId: "deleted",
      url: "https://example.com/",
    },
    profiles: async () => [
      { id: "other-account", name: "Other", isDefault: true },
    ],
    console: { log: (value: string) => output.push(value) },
    URL,
  })
  assert.deepEqual(JSON.parse(output[0]), { error: "source_missing" })
})

test("exports only the bound site's data even when a page resource keeps loading", async () => {
  const script = await readFile(path, "utf8")
  const output: string[] = []
  let closed = false
  await vm.runInNewContext(`(async()=>{${script}})()`, {
    request: {
      mode: "read",
      profileId: "primary",
      url: "https://example.com/account",
    },
    profiles: async () => [
      { id: "primary", name: "Primary", isDefault: false },
    ],
    taskSpace: async (_name: string, options: { profileId: string }) => {
      assert.equal(options.profileId, "primary")
      return {
        ownership: "agent",
        page: () => ({
          goto: async (_url: string, options?: { waitUntil?: string }) => {
            if (
              options?.waitUntil !== "commit" &&
              options?.waitUntil !== "domcontentloaded"
            ) {
              throw new Error(
                "Navigation committed but timed out waiting for load"
              )
            }
          },
          url: async () => "https://example.com/login",
          evaluate: async () => ({ token: "synthetic-only" }),
          cdp: async (method: string, params: { urls: string[] }) => {
            assert.equal(method, "Network.getCookies")
            assert.deepEqual(Array.from(params.urls), [
              "https://example.com/account",
            ])
            return {
              cookies: [
                {
                  name: "session",
                  value: "synthetic-only",
                  domain: "example.com",
                  path: "/",
                },
              ],
            }
          },
        }),
        finish: async () => {
          closed = true
        },
      }
    },
    console: { log: (value: string) => output.push(value) },
    URL,
  })
  const result = JSON.parse(output[0])
  assert.equal(result.origin, "https://example.com")
  assert.equal(result.cookies.length, 1)
  assert.equal(result.storage.token, "synthetic-only")
  assert.equal(closed, true)
})

test("does not export storage after a sign-in redirect reaches another site", async () => {
  const script = await readFile(path, "utf8")
  const output: string[] = []
  let readStorage = false
  let finished = false
  await vm.runInNewContext(`(async()=>{${script}})()`, {
    request: {
      mode: "read",
      profileId: "primary",
      url: "https://example.com/account",
    },
    profiles: async () => [
      { id: "primary", name: "Primary", isDefault: false },
    ],
    taskSpace: async () => ({
      ownership: "agent",
      page: () => ({
        goto: async () => {},
        url: async () => "https://identity.example.net/login",
        evaluate: async () => {
          readStorage = true
          return {}
        },
      }),
      finish: async () => {
        finished = true
      },
    }),
    console: { log: (value: string) => output.push(value) },
    URL,
  })
  assert.deepEqual(JSON.parse(output[0]), { error: "unsupported" })
  assert.equal(readStorage, false)
  assert.equal(finished, true)
})

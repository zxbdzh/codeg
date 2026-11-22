import assert from "node:assert/strict"
import test from "node:test"
import { apply } from "./dsh-readonly.mjs"

test("DSH side questions reject side effects at the native dispatch boundary", () => {
  let guard
  apply({
    tools: {
      guard(callback) {
        guard = callback
      },
    },
    provide() {},
  })
  for (const name of ["write", "edit", "apply_patch", "bash", "pwsh", "run_code", "mcp_write", "subagent"]) {
    assert.match(guard({ name }), /read-only/i, name)
  }
  for (const name of ["read", "read_image", "glob", "grep"]) {
    assert.equal(guard({ name }), undefined, name)
  }
})

test("DSH without a final native execution guard fails before starting", () => {
  assert.throws(() => apply({ tools: {} }), /guard/i)
})

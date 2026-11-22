export const name = "codeg-side-readonly"
export const inject = ["tools"]

const allowedTools = new Set(["read", "read_image", "glob", "grep"])

export function apply(ctx) {
  if (typeof ctx.tools?.guard !== "function") {
    throw new Error("DSH side questions require the native tools.guard API")
  }
  // 最终 guard 在审批之后执行；权限切换、恢复旧会话和 MCP 均不能放开写入工具。
  ctx.tools.guard(({ name: toolName }) =>
    allowedTools.has(toolName)
      ? undefined
      : "Codeg side questions are read-only; this tool is disabled."
  )
  ctx.provide("codegSideReadonly", true)
}

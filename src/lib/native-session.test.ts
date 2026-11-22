import { describe, expect, it, vi } from "vitest"

import {
  closeNativeMainSession,
  closeNativeSideQuestion,
  createNativeSideQuestion,
  listNativeSideQuestions,
  openNativeMainSession,
  openNativeSideQuestion,
  supportsNativeTerminal,
} from "./native-session"

function transport() {
  return {
    call: vi.fn<
      (command: string, args?: Record<string, unknown>) => Promise<unknown>
    >(async () => undefined),
  }
}

const source = {
  sourceConnectionId: "connection-1",
  sourceConversationId: 12,
  sourceAgentType: "codex" as const,
}

describe("native-session transport contract", () => {
  it("enables only the four shipped native terminal agents", () => {
    for (const agent of ["codex", "claude_code", "pi", "deepseek"]) {
      expect(supportsNativeTerminal(agent)).toBe(true)
    }
    expect(supportsNativeTerminal("gemini")).toBe(false)
  })

  it("lists side questions with the source identity", async () => {
    const t = transport()
    await listNativeSideQuestions(t as never, source)
    expect(t.call).toHaveBeenCalledWith("native_session_list", source)
  })

  it("creates a side question and returns the terminal id", async () => {
    const t = transport()
    t.call.mockResolvedValue({
      sideQuestion: {
        id: "side-1",
        sourceSessionId: "main",
        branchSessionId: "branch",
        agentType: "codex",
        cwd: "/repo",
        title: "Why?",
        isOpen: true,
      },
      terminalId: "terminal-1",
    })

    const request = { requestId: "side-request-1", title: "Why?" }
    const result = await createNativeSideQuestion(t as never, source, request)

    expect(t.call).toHaveBeenCalledWith(
      "native_session_create_side",
      { ...source, ...request },
      { timeoutMs: 180_000 }
    )
    expect(result.terminalId).toBe("terminal-1")
  })

  it("opens and closes a side question by id", async () => {
    const t = transport()
    t.call.mockResolvedValue({ terminalId: "terminal-2" })
    await openNativeSideQuestion(t as never, "side-1")
    expect(t.call).toHaveBeenCalledWith("native_session_open_side", {
      sideQuestionId: "side-1",
    })
    await closeNativeSideQuestion(t as never, "side-1")
    expect(t.call).toHaveBeenCalledWith("native_session_close_side", {
      sideQuestionId: "side-1",
    })
  })

  it("opens and closes the main terminal with its original identity", async () => {
    const t = transport()
    t.call.mockResolvedValue({ terminalId: "main-terminal" })
    const opened = await openNativeMainSession(t as never, source)
    expect(t.call).toHaveBeenCalledWith("native_session_open_main", source)
    expect(opened).toEqual({
      terminalId: "main-terminal",
      sourceConnectionId: "connection-1",
    })

    t.call.mockResolvedValue({ connectionId: "connection-2" })
    await closeNativeMainSession(t as never, "connection-1", "main-terminal")
    expect(t.call).toHaveBeenCalledWith("native_session_close_main", {
      sourceConnectionId: "connection-1",
      terminalId: "main-terminal",
    })
  })

  it("returns the restored ACP connection id after closing the main terminal", async () => {
    const t = transport()
    t.call.mockResolvedValue({ connectionId: "connection-2" })

    const restored = await closeNativeMainSession(
      t as never,
      "connection-1",
      "main-terminal"
    )

    expect(restored).toEqual({ connectionId: "connection-2" })
  })
})

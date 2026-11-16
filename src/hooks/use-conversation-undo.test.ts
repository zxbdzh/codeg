import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { useConversationUndo } from "./use-conversation-undo"

const mocks = vi.hoisted(() => ({
  undo: vi.fn(),
  complete: vi.fn(),
  failure: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
vi.mock("sonner", () => ({
  toast: {
    success: mocks.success,
    error: mocks.error,
    info: mocks.info,
  },
}))
vi.mock("@/lib/conversation-undo", () => ({
  undoConversation: mocks.undo,
}))

const prompt = {
  text: "撤回这条消息",
  timestamp: "2026-11-17T00:00:00Z",
  agentMessageId: null,
}
const response = { conversationId: 12, sessionId: "same-session" }

function setup(busy = false) {
  return renderHook(() =>
    useConversationUndo({
      conversationId: 12,
      busy,
      onComplete: mocks.complete,
      onFailure: mocks.failure,
    })
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.undo.mockReset().mockResolvedValue(response)
  mocks.complete.mockReset().mockResolvedValue(undefined)
  mocks.failure.mockReset().mockResolvedValue(undefined)
})

describe("useConversationUndo", () => {
  it("keeps cancellation local without submitting an undo", () => {
    const { result } = setup()
    act(() => result.current.requestUndo("turn-2", prompt.text, false, prompt))
    expect(result.current.selection?.text).toBe(prompt.text)
    act(() => result.current.cancelUndo())
    expect(result.current.selection).toBeNull()
    expect(mocks.undo).not.toHaveBeenCalled()
  })

  it("blocks undo while session work is running", () => {
    const { result } = setup(true)
    act(() => result.current.requestUndo("turn-2", prompt.text, false, prompt))
    expect(result.current.selection).toBeNull()
    expect(mocks.info).toHaveBeenCalledWith("busy")
    expect(mocks.undo).not.toHaveBeenCalled()
  })

  it("returns the original text only after native undo succeeds", async () => {
    const { result } = setup()
    act(() => result.current.requestUndo("turn-2", prompt.text, false, prompt))
    await act(() => result.current.confirmUndo())
    expect(mocks.undo).toHaveBeenCalledWith({
      conversationId: 12,
      sourceTurnId: "turn-2",
      sourcePrompt: prompt,
    })
    expect(mocks.complete).toHaveBeenCalledWith(response, prompt.text)
    expect(mocks.failure).not.toHaveBeenCalled()
    expect(mocks.success).toHaveBeenCalledWith("done")
    expect(result.current.selection).toBeNull()
    expect(result.current.pending).toBe(false)
  })

  it("recovers a failed connection without filling the composer", async () => {
    mocks.undo.mockRejectedValue(new Error("native history operation failed"))
    const { result } = setup()
    act(() => result.current.requestUndo("turn-2", prompt.text, false, prompt))
    await act(() => result.current.confirmUndo())
    expect(mocks.failure).toHaveBeenCalledWith(12)
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalledWith("failed")
    expect(result.current.selection).toBeNull()
    expect(result.current.pending).toBe(false)
  })

  it("submits only once when confirm is clicked twice", async () => {
    let resolveUndo!: (value: typeof response) => void
    mocks.undo.mockReturnValue(
      new Promise<typeof response>((resolve) => {
        resolveUndo = resolve
      })
    )
    const { result } = setup()
    act(() => result.current.requestUndo("turn-2", prompt.text, false, prompt))
    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.confirmUndo()
      second = result.current.confirmUndo()
    })
    expect(mocks.undo).toHaveBeenCalledTimes(1)
    expect(result.current.pending).toBe(true)
    await act(async () => {
      resolveUndo(response)
      await Promise.all([first, second])
    })
    expect(mocks.complete).toHaveBeenCalledTimes(1)
    expect(result.current.pending).toBe(false)
  })
})

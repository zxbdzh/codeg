import { beforeEach, describe, expect, it, vi } from "vitest"
import { undoConversation } from "./conversation-undo"

const transport = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock("@/lib/transport", () => ({ getTransport: () => transport }))

beforeEach(() => transport.call.mockReset())

describe("conversation undo", () => {
  it("sends the selected prompt identity to the in-place undo endpoint", async () => {
    const request = {
      conversationId: 12,
      sourceTurnId: "turn-2",
      sourcePrompt: {
        text: "Try again",
        timestamp: "2026-11-16T10:00:00Z",
        agentMessageId: null,
      },
    }
    const result = { conversationId: 12, sessionId: "codex-session-1" }
    transport.call.mockResolvedValue(result)

    await expect(undoConversation(request)).resolves.toEqual(result)
    expect(transport.call).toHaveBeenCalledWith("conversation_undo", request, {
      timeoutMs: 30 * 60_000,
    })
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createResearchBranch, snapshotForkPrompt } from "./research-branch"
import type { MessageTurn } from "./types"

const transport = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock("@/lib/transport", () => ({ getTransport: () => transport }))

beforeEach(() => transport.call.mockReset())

describe("conversation fork", () => {
  it("passes the selected historical prompt to the only fork endpoint", async () => {
    const request = {
      connectionId: "connection-1",
      sourceConversationId: 12,
      requestId: "request-1",
      sourceTurnId: "turn-2",
      sourcePrompt: {
        text: "Try again",
        timestamp: "2026-11-11",
        agentMessageId: null,
      },
    }
    transport.call.mockResolvedValue({ branchConversationId: 13 })
    await expect(createResearchBranch(request)).resolves.toEqual({
      branchConversationId: 13,
    })
    expect(transport.call).toHaveBeenCalledWith("conversation_fork", request, {
      timeoutMs: 30 * 60_000,
    })
  })

  it("snapshots original text and identity without copying tools or reasoning", () => {
    const turn = {
      id: "turn-2",
      role: "user",
      timestamp: "2026-11-11T01:00:00Z",
      agent_message_id: "message-2",
      blocks: [
        { type: "text", text: "Original prompt" },
        { type: "thinking", text: "private" },
        { type: "text", text: "Second line" },
      ],
    } satisfies MessageTurn
    expect(snapshotForkPrompt(turn)).toEqual({
      text: "Original prompt\nSecond line",
      timestamp: turn.timestamp,
      agentMessageId: "message-2",
    })
  })
})

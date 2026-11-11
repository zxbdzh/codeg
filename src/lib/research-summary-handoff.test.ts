import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  clearForkPromptHandoffs,
  consumeForkConversationPrompt,
  consumeForkPromptDraft,
  parkForkPromptDraft,
  parkForkConversationPrompt,
  FORK_PROMPT_READY_EVENT,
} from "./research-summary-handoff"

beforeEach(clearForkPromptHandoffs)

describe("fork prompt draft handoff", () => {
  it("keeps a first prompt in a draft tab until the composer consumes it once", () => {
    parkForkPromptDraft("new-tab", "My first question")
    expect(consumeForkPromptDraft("other-tab")).toBeNull()
    expect(consumeForkPromptDraft("new-tab")).toBe("My first question")
    expect(consumeForkPromptDraft("new-tab")).toBeNull()
    parkForkPromptDraft("new-tab", "old backend")
    clearForkPromptHandoffs()
    expect(consumeForkPromptDraft("new-tab")).toBeNull()
  })

  it("keeps prompts on their selected conversation and consumes only once", () => {
    parkForkConversationPrompt(12, "selected question")
    expect(consumeForkConversationPrompt(13)).toBeNull()
    expect(consumeForkConversationPrompt(12)).toBe("selected question")
    expect(consumeForkConversationPrompt(12)).toBeNull()
  })

  it("notifies an already mounted composer without placing text in the event", () => {
    const listener = vi.fn()
    window.addEventListener(FORK_PROMPT_READY_EVENT, listener)
    try {
      parkForkConversationPrompt(5, "selected question")
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener.mock.calls[0][0].detail).toEqual({ conversationId: 5 })
      expect(consumeForkConversationPrompt(5)).toBe("selected question")
    } finally {
      window.removeEventListener(FORK_PROMPT_READY_EVENT, listener)
    }
  })

  it("drops pending drafts on a backend reset", () => {
    parkForkConversationPrompt(1, "old backend")
    clearForkPromptHandoffs()
    expect(consumeForkConversationPrompt(1)).toBeNull()
  })
})

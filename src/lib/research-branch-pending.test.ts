import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => null,
}))

import {
  clearResearchCreationCache,
  finishResearchCreation,
  pendingResearchCreation,
  rememberResearchCreation,
} from "./research-branch-pending"

beforeEach(() => {
  clearResearchCreationCache()
  sessionStorage.clear()
})

describe("pending research creation", () => {
  it("keeps different historical fork points and tail retries separate", () => {
    rememberResearchCreation(12, "tail")
    rememberResearchCreation(12, "first-history", "turn-2")
    rememberResearchCreation(12, "second-history", "turn-4")
    clearResearchCreationCache()
    expect(pendingResearchCreation(12)).toBe("tail")
    expect(pendingResearchCreation(12, "turn-2")).toBe("first-history")
    expect(pendingResearchCreation(12, "turn-4")).toBe("second-history")
    finishResearchCreation(12, "first-history", "turn-2")
    expect(pendingResearchCreation(12, "turn-2")).toBeNull()
    expect(pendingResearchCreation(12, "turn-4")).toBe("second-history")
  })

  it("restores the same source request after the in-memory cache is lost", () => {
    rememberResearchCreation(12, "fork-started")
    clearResearchCreationCache()
    expect(pendingResearchCreation(12)).toBe("fork-started")
    expect(pendingResearchCreation(13)).toBeNull()
    finishResearchCreation(12, "older-request")
    expect(pendingResearchCreation(12)).toBe("fork-started")
    finishResearchCreation(12, "fork-started")
    expect(pendingResearchCreation(12)).toBeNull()
  })

  it("never replays a pending fork for a different message at the same position", () => {
    const snapshot = {
      text: "original",
      timestamp: "2026-11-10T01:00:00Z",
      agentMessageId: null,
    }
    rememberResearchCreation(12, "original-request", "turn-2", snapshot)
    expect(pendingResearchCreation(12, "turn-2", snapshot)).toBe(
      "original-request"
    )
    expect(
      pendingResearchCreation(12, "turn-2", {
        ...snapshot,
        text: "changed after compaction",
      })
    ).toBeNull()
    clearResearchCreationCache()
    expect(pendingResearchCreation(12, "turn-2", snapshot)).toBe(
      "original-request"
    )
    expect(
      pendingResearchCreation(12, "turn-2", {
        ...snapshot,
        timestamp: "2026-11-10T01:01:00Z",
      })
    ).toBeNull()
    rememberResearchCreation(12, "new-request", "turn-2", snapshot)
    finishResearchCreation(12, "original-request", "turn-2")
    expect(pendingResearchCreation(12, "turn-2", snapshot)).toBe("new-request")
  })
})

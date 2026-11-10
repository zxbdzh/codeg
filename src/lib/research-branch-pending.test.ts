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
})

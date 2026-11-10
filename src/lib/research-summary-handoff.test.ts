import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  clearResearchSummaryHandoffs,
  consumeResearchSummaries,
  parkResearchSummary,
  RESEARCH_SUMMARY_READY_EVENT,
} from "./research-summary-handoff"

beforeEach(clearResearchSummaryHandoffs)

describe("research summary draft handoff", () => {
  it("keeps summaries on their selected source and consumes only once", () => {
    parkResearchSummary(12, "first")
    parkResearchSummary(12, "second")
    expect(consumeResearchSummaries(13)).toEqual([])
    expect(consumeResearchSummaries(12)).toEqual(["first", "second"])
    expect(consumeResearchSummaries(12)).toEqual([])
  })

  it("notifies an already mounted composer without placing text in the event", () => {
    const listener = vi.fn()
    window.addEventListener(RESEARCH_SUMMARY_READY_EVENT, listener)
    try {
      parkResearchSummary(5, "chosen conclusion")
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener.mock.calls[0][0].detail).toEqual({ conversationId: 5 })
      expect(consumeResearchSummaries(5)).toEqual(["chosen conclusion"])
    } finally {
      window.removeEventListener(RESEARCH_SUMMARY_READY_EVENT, listener)
    }
  })

  it("drops pending drafts on a backend reset", () => {
    parkResearchSummary(1, "old backend")
    clearResearchSummaryHandoffs()
    expect(consumeResearchSummaries(1)).toEqual([])
  })
})

import { describe, expect, it } from "vitest"

import type { MessageTurn, WhaleBalanceSnapshot } from "./types"
import {
  DEFAULT_SNAP,
  snapWhalePosition,
  whaleAlertKeys,
  whaleTurnUsage,
  weightedIndex,
} from "./whale-widget"

describe("snapWhalePosition", () => {
  it("anchors the right and bottom edges without a gap", () => {
    const result = snapWhalePosition(
      { x: 400, y: 400 },
      { x: 500, y: 500 },
      100,
      DEFAULT_SNAP
    )
    expect(result.position).toEqual({ x: null, y: null })
    expect(result.mirror).toBe(false)
  })

  it("anchors left and mirrors the avatar", () => {
    const result = snapWhalePosition(
      { x: 0, y: 500 },
      { x: 500, y: 500 },
      100,
      DEFAULT_SNAP
    )
    expect(result.position).toEqual({ x: 0, y: null })
    expect(result.mirror).toBe(true)
  })
})

describe("weightedIndex", () => {
  it("weights choices and avoids repeating the previous item", () => {
    expect(weightedIndex([1, 3], 0.5, -1)).toBe(1)
    expect(weightedIndex([1, 3], 0, 1)).toBe(0)
  })
})

describe("whaleAlertKeys", () => {
  it("reports low balance and daily budget", () => {
    const snapshot = {
      configured: true,
      stale: false,
      lastError: null,
      lastSuccessAt: "2026-11-25T10:00:00Z",
      modelId: "deepseek",
      balance: 2,
      observedToday: 10,
      accountGeneration: 1,
    } as WhaleBalanceSnapshot
    const result = whaleAlertKeys(
      snapshot,
      { alerts: { deepseek: { low: 5, budget: 10 } } },
      0
    )
    expect(result.low).toContain("deepseek:1:5")
    expect(result.budget).toContain("deepseek:1:10")
  })
})

describe("whaleTurnUsage", () => {
  it("sums the latest turn and prices cache reads separately", () => {
    const turns = [
      { role: "user", timestamp: "2026-11-25T10:00:00Z" },
      {
        role: "assistant",
        timestamp: "2026-11-25T10:00:10Z",
        completed_at: "2026-11-25T10:00:10Z",
        model: "deepseek-chat",
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 4,
        },
      },
    ] as MessageTurn[]
    const result = whaleTurnUsage(
      turns,
      Date.parse("2026-11-25T10:00:00Z"),
      Date.parse("2026-11-25T10:00:10Z"),
      { peakPrice: 1, offPeakPrice: 1, currency: "CNY" },
      { "deepseek-chat": { input: 1, cache: 0.5, output: 2, exchange: 1 } }
    )
    expect(result?.tokens).toBe(7)
    expect(result?.cost).toBeCloseTo(7 / 1_000_000, 10)
  })
})

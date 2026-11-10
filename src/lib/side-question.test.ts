import { describe, expect, it } from "vitest"

import type { ConversationTimelineTurn } from "@/stores/conversation-runtime-store"
import {
  buildSideQuestionContext,
  truncateSideQuestionSelection,
  unicodeLength,
} from "./side-question"

function message(
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  overrides: Partial<ConversationTimelineTurn> = {}
): ConversationTimelineTurn {
  return {
    key: id,
    phase: "persisted",
    turn: {
      id,
      role,
      blocks: [{ type: "text", text }],
      timestamp: "2026-11-10T00:00:00Z",
    },
    ...overrides,
  }
}

describe("side question context", () => {
  it("keeps only completed text and joins every text block", () => {
    const withTools = message("answer", "assistant", "first")
    withTools.turn.blocks.push(
      { type: "thinking", text: "private reasoning" },
      {
        type: "tool_result",
        output_preview: "raw output",
        tool_use_id: "tool-1",
        is_error: false,
      },
      { type: "text", text: "second" }
    )
    expect(
      buildSideQuestionContext([
        message("system", "system", "system instruction"),
        message("question", "user", "question"),
        withTools,
        message("optimistic", "user", "not sent", { phase: "optimistic" }),
        message("streaming", "assistant", "not complete", {
          phase: "streaming",
        }),
        message("inflight", "assistant", "persisted partial", {
          isInFlightRound: true,
        }),
      ])
    ).toEqual([
      { role: "user", text: "question" },
      { role: "assistant", text: "first\nsecond" },
    ])
  })

  it("takes the latest twelve messages in their original order", () => {
    const history = Array.from({ length: 16 }, (_, index) =>
      message(`turn-${index}`, "assistant", `answer-${index}`)
    )
    expect(buildSideQuestionContext(history)).toEqual(
      history.slice(4).map((item) => ({
        role: "assistant",
        text: `answer-${item.turn.id.slice(5)}`,
      }))
    )
  })

  it("keeps a strict Unicode budget, including a single enormous reply", () => {
    const context = buildSideQuestionContext([
      message("old", "user", "earlier context"),
      message("large", "assistant", "😀".repeat(12_005)),
    ])
    expect(context).toEqual([{ role: "assistant", text: "😀".repeat(12_000) }])
    expect(unicodeLength(context[0].text)).toBe(12_000)
  })

  it("fills the remaining budget from the most recent end of an older message", () => {
    expect(
      buildSideQuestionContext([
        message("old", "user", `${"x".repeat(2_000)}末尾`),
        message("new", "assistant", "新".repeat(11_999)),
      ])
    ).toEqual([
      { role: "user", text: "尾" },
      { role: "assistant", text: "新".repeat(11_999) },
    ])
  })

  it("clips selections without splitting surrogate pairs", () => {
    expect(truncateSideQuestionSelection("😀".repeat(8_001))).toBe(
      "😀".repeat(8_000)
    )
  })
})

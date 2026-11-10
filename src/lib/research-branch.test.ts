import { beforeEach, describe, expect, it, vi } from "vitest"

const transport = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock("@/lib/transport", () => ({ getTransport: () => transport }))

import {
  cancelResearchBranchSummary,
  createResearchBranch,
  generateResearchBranchSummary,
  listResearchBranches,
  saveResearchBranchSummary,
} from "./research-branch"

beforeEach(() => {
  transport.call.mockReset()
})

describe("research branch API", () => {
  it("creates at the session tail with camelCase arguments and a long timeout", async () => {
    const request = {
      connectionId: "connection-1",
      sourceConversationId: 10,
      requestId: "create-1",
    }
    const info = { id: 1, branchConversationId: 20, boundary: "session_tail" }
    transport.call.mockResolvedValue(info)

    expect(await createResearchBranch(request)).toBe(info)
    expect(transport.call).toHaveBeenCalledWith(
      "research_branch_create",
      request,
      { timeoutMs: 1_800_000 }
    )
  })

  it("lists persisted relations by either source or branch conversation", async () => {
    transport.call.mockResolvedValue([])
    expect(await listResearchBranches(20)).toEqual([])
    expect(transport.call).toHaveBeenCalledWith(
      "research_branch_list",
      { conversationId: 20 },
      { timeoutMs: 60_000 }
    )
  })

  it("saves exactly the supplied summary with the ordinary timeout", async () => {
    const info = { id: 1, summary: "  手动结论\n保留原文  " }
    transport.call.mockResolvedValue(info)
    expect(await saveResearchBranchSummary(20, info.summary)).toBe(info)
    expect(transport.call).toHaveBeenCalledWith(
      "research_branch_save_summary",
      { branchConversationId: 20, summary: info.summary },
      { timeoutMs: 60_000 }
    )
  })

  it("allows 12000 Unicode code points, including surrogate pairs", async () => {
    const summary = "😀".repeat(12_000)
    transport.call.mockResolvedValue({ summary })
    await saveResearchBranchSummary(20, summary)
    expect(transport.call).toHaveBeenCalledWith(
      "research_branch_save_summary",
      { branchConversationId: 20, summary },
      { timeoutMs: 60_000 }
    )
  })

  it("rejects overlong summaries before making an API call", async () => {
    await expect(
      saveResearchBranchSummary(20, "😀".repeat(12_001))
    ).rejects.toThrow("12000")
    expect(transport.call).not.toHaveBeenCalled()
  })

  it("allows an empty summary when clearing a saved draft", async () => {
    await saveResearchBranchSummary(20, "")
    expect(transport.call).toHaveBeenCalledWith(
      "research_branch_save_summary",
      { branchConversationId: 20, summary: "" },
      { timeoutMs: 60_000 }
    )
  })

  it("generates a real one-shot summary via the dedicated API", async () => {
    transport.call.mockResolvedValue({ summary: "结论" })
    const request = { branchConversationId: 20, requestId: "summary-1" }
    expect(await generateResearchBranchSummary(request)).toEqual({
      summary: "结论",
    })
    expect(transport.call).toHaveBeenCalledWith(
      "research_branch_generate_summary",
      request,
      { timeoutMs: 1_800_000 }
    )
  })

  it("reuses side-question cancellation with the same request ID", async () => {
    await cancelResearchBranchSummary("summary-1")
    expect(transport.call).toHaveBeenCalledWith(
      "side_question_cancel",
      { requestId: "summary-1" },
      { timeoutMs: 60_000 }
    )
  })

  it("preserves backend failures for caller retry handling", async () => {
    const error = new Error("offline")
    transport.call.mockRejectedValue(error)
    await expect(listResearchBranches(10)).rejects.toBe(error)
  })
})

import { getTransport } from "@/lib/transport"

export const RESEARCH_BRANCH_MAX_SUMMARY_CHARS = 12_000

export interface ResearchBranchInfo {
  id: number
  sourceConversationId: number
  branchConversationId: number
  sourceSessionId: string
  branchSessionId: string
  sourceTurnId: string | null
  boundary: "session_tail"
  title: string
  sourceTitle: string
  summary: string
  createdAt: string
}

export interface CreateResearchBranchRequest {
  connectionId: string
  sourceConversationId: number
  requestId: string
}

export interface GenerateResearchBranchSummaryRequest {
  branchConversationId: number
  requestId: string
}

export function createResearchBranch(
  request: CreateResearchBranchRequest
): Promise<ResearchBranchInfo> {
  return getTransport().call(
    "research_branch_create",
    { ...request },
    { timeoutMs: 30 * 60_000 }
  )
}

export function listResearchBranches(
  conversationId: number
): Promise<ResearchBranchInfo[]> {
  return getTransport().call(
    "research_branch_list",
    { conversationId },
    { timeoutMs: 60_000 }
  )
}

export function saveResearchBranchSummary(
  branchConversationId: number,
  summary: string
): Promise<ResearchBranchInfo> {
  // 按 Unicode 码点计数，避免把双 UTF-16 单元的字符误判为超限。
  if (Array.from(summary).length > RESEARCH_BRANCH_MAX_SUMMARY_CHARS) {
    return Promise.reject(
      new Error("Research branch summary exceeds 12000 characters")
    )
  }
  return getTransport().call(
    "research_branch_save_summary",
    { branchConversationId, summary },
    { timeoutMs: 60_000 }
  )
}

export function generateResearchBranchSummary(
  request: GenerateResearchBranchSummaryRequest
): Promise<{ summary: string }> {
  return getTransport().call(
    "research_branch_generate_summary",
    { ...request },
    { timeoutMs: 30 * 60_000 }
  )
}

export function cancelResearchBranchSummary(requestId: string): Promise<void> {
  return getTransport().call(
    "side_question_cancel",
    { requestId },
    { timeoutMs: 60_000 }
  )
}

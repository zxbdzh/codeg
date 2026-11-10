import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"

export const RESEARCH_SUMMARY_READY_EVENT = "codeg:research-summary-ready"

const pending = new Map<number, string[]>()
const summaryDrafts = new Map<number, { text: string; saved: string }>()

export function readResearchSummaryDraft(
  conversationId: number
): { text: string; saved: string } | null {
  return summaryDrafts.get(conversationId) ?? null
}

export function writeResearchSummaryDraft(
  conversationId: number,
  draft: { text: string; saved: string }
): void {
  summaryDrafts.set(conversationId, draft)
}

export function parkResearchSummary(
  conversationId: number,
  summary: string
): void {
  const text = summary.trim()
  if (!text) return
  // 摘要只进入指定主线的草稿缓冲，不复用会自动发送的选区提问队列。
  pending.set(conversationId, [...(pending.get(conversationId) ?? []), text])
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(RESEARCH_SUMMARY_READY_EVENT, {
        detail: { conversationId },
      })
    )
  }
}

export function consumeResearchSummaries(conversationId: number): string[] {
  const summaries = pending.get(conversationId) ?? []
  pending.delete(conversationId)
  return summaries
}

export function clearResearchSummaryHandoffs(): void {
  pending.clear()
  summaryDrafts.clear()
}

registerBackendScopedStoreReset(clearResearchSummaryHandoffs)

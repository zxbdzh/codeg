import type { PromptDraft } from "@/lib/types"

export interface SideQuestionDraftSnapshot {
  token: string
  draft: PromptDraft
  requestId?: string
}

type DraftKind = "source" | "question"

function key(backend: number | null, kind: DraftKind, id: number) {
  return `side-question-pending:${JSON.stringify([backend, kind, id])}`
}

export function saveSideQuestionDraft(
  backend: number | null,
  kind: DraftKind,
  id: number,
  snapshot: SideQuestionDraftSnapshot
) {
  try {
    // 独立于编辑器草稿，发送清空或页面退出前也必须已经落盘。
    localStorage.setItem(key(backend, kind, id), JSON.stringify(snapshot))
    return true
  } catch {
    return false
  }
}

export function loadSideQuestionDraft(
  backend: number | null,
  kind: DraftKind,
  id: number
): SideQuestionDraftSnapshot | null {
  try {
    const saved = JSON.parse(
      localStorage.getItem(key(backend, kind, id)) ?? "null"
    ) as Partial<SideQuestionDraftSnapshot> | null
    return typeof saved?.token === "string" &&
      Array.isArray(saved.draft?.blocks) &&
      typeof saved.draft.displayText === "string"
      ? (saved as SideQuestionDraftSnapshot)
      : null
  } catch {
    return null
  }
}

export function clearSideQuestionDraft(
  backend: number | null,
  kind: DraftKind,
  id: number,
  token: string
) {
  try {
    // 较早发送的迟到回执不能删除新提交的草稿。
    if (loadSideQuestionDraft(backend, kind, id)?.token === token) {
      localStorage.removeItem(key(backend, kind, id))
    }
  } catch {
    // 已受理的发送不能因清理失败而按发送失败处理。
  }
}

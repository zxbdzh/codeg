"use client"

import { create } from "zustand"

import { toErrorMessage } from "@/lib/app-error"
import {
  askSideQuestion,
  cancelSideQuestionRequest,
  truncateSideQuestionSelection,
  type SideQuestionAnswer,
  type SideQuestionContextEntry,
} from "@/lib/side-question"
import { getTransport } from "@/lib/transport"
import type { Transport } from "@/lib/transport/types"
import { randomUUID } from "@/lib/utils"
import { registerBackendScopedStoreReset } from "./backend-scoped-store-reset"

export interface SideQuestionEntry {
  question: string
  selection: string
  status: "idle" | "loading" | "done" | "cancelled" | "error"
  askedQuestion: string | null
  result: SideQuestionAnswer | null
  error: string | null
}

export const EMPTY_SIDE_QUESTION: SideQuestionEntry = {
  question: "",
  selection: "",
  status: "idle",
  askedQuestion: null,
  result: null,
  error: null,
}

interface PendingQuestion {
  requestId: string
  transport: Transport
}

interface SideQuestionStore {
  bySource: Record<string, SideQuestionEntry>
  setQuestion(sourceKey: string, question: string): void
  setSelection(sourceKey: string, selection: string): void
  useRecentContext(sourceKey: string): void
  ask(sourceKey: string, context: SideQuestionContextEntry[]): Promise<void>
  cancel(sourceKey: string): void
}

const pending = new Map<string, PendingQuestion>()

/** 标签草稿绑定到真实会话后仍沿用原 key，切换项目或代理则隔离旁问。 */
export function sideQuestionSourceKey(source: {
  id: string
  folderId: number
  agentType: string
}): string {
  return `${source.id}:${source.folderId}:${source.agentType}`
}

export const useSideQuestionStore = create<SideQuestionStore>((set, get) => {
  const update = (sourceKey: string, patch: Partial<SideQuestionEntry>) => {
    set((state) => ({
      bySource: {
        ...state.bySource,
        [sourceKey]: {
          ...(state.bySource[sourceKey] ?? EMPTY_SIDE_QUESTION),
          ...patch,
        },
      },
    }))
  }

  const cancel = (sourceKey: string) => {
    const job = pending.get(sourceKey)
    if (!job) return
    // 先撤销本地所有权，取消请求或旧回答稍后到达也不能覆盖下一次旁问。
    pending.delete(sourceKey)
    update(sourceKey, { status: "cancelled", error: null })
    void cancelSideQuestionRequest(job.transport, job.requestId).catch(() => {})
  }

  return {
    bySource: {},
    setQuestion: (sourceKey, question) => update(sourceKey, { question }),
    setSelection: (sourceKey, selection) => {
      cancel(sourceKey)
      update(sourceKey, {
        ...EMPTY_SIDE_QUESTION,
        selection: truncateSideQuestionSelection(selection),
      })
    },
    useRecentContext: (sourceKey) => {
      cancel(sourceKey)
      update(sourceKey, {
        selection: "",
        status: "idle",
        result: null,
        error: null,
        askedQuestion: null,
      })
    },
    cancel,
    ask: async (sourceKey, context) => {
      if (pending.has(sourceKey)) return
      const entry = get().bySource[sourceKey] ?? EMPTY_SIDE_QUESTION
      const question = entry.question.trim()
      if (!question) return
      const job = { requestId: randomUUID(), transport: getTransport() }
      pending.set(sourceKey, job)
      update(sourceKey, {
        status: "loading",
        askedQuestion: question,
        result: null,
        error: null,
      })
      try {
        const result = await askSideQuestion(job.transport, {
          requestId: job.requestId,
          question,
          selection: entry.selection || null,
          context: entry.selection ? [] : context,
        })
        if (pending.get(sourceKey) !== job) return
        update(sourceKey, { status: "done", result })
      } catch (error) {
        if (pending.get(sourceKey) !== job) return
        update(sourceKey, { status: "error", error: toErrorMessage(error) })
      } finally {
        if (pending.get(sourceKey) === job) pending.delete(sourceKey)
      }
    },
  }
})

export function resetSideQuestions(): void {
  for (const [sourceKey] of pending) {
    useSideQuestionStore.getState().cancel(sourceKey)
  }
  useSideQuestionStore.setState({ bySource: {} })
}

registerBackendScopedStoreReset(resetSideQuestions)

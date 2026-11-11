"use client"

import { create } from "zustand"

import { toErrorMessage } from "@/lib/app-error"
import {
  askSideQuestion,
  cancelSideQuestionRequest,
  SIDE_QUESTION_MAX_CONTEXT_CHARS,
  SIDE_QUESTION_MAX_MESSAGES,
  truncateSideQuestionSelection,
  type SideQuestionAnswer,
  type SideQuestionContextEntry,
  type SideQuestionSource,
} from "@/lib/side-question"
import { getTransport } from "@/lib/transport"
import type { Transport } from "@/lib/transport/types"
import { randomUUID } from "@/lib/utils"
import {
  sideAttachmentPayload,
  type SideQuestionDraftAttachment,
} from "@/lib/side-question-attachments"
import { registerBackendScopedStoreReset } from "./backend-scoped-store-reset"

export interface SideQuestionTurn {
  id: string
  question: string
  attachments: SideQuestionDraftAttachment[]
  status: "loading" | "done" | "cancelled" | "error"
  result: SideQuestionAnswer | null
  error: string | null
}

export interface SideQuestionEntry {
  turns: SideQuestionTurn[]
  contextSnapshot: SideQuestionContextEntry[] | null
  question: string
  selection: string
  status: "idle" | "loading" | "done" | "cancelled" | "error"
  askedQuestion: string | null
  attachments: SideQuestionDraftAttachment[]
  askedAttachments: SideQuestionDraftAttachment[]
  result: SideQuestionAnswer | null
  error: string | null
}

export const EMPTY_SIDE_QUESTION: SideQuestionEntry = {
  turns: [],
  contextSnapshot: null,
  question: "",
  selection: "",
  status: "idle",
  askedQuestion: null,
  attachments: [],
  askedAttachments: [],
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
  addAttachments(
    sourceKey: string,
    attachments: SideQuestionDraftAttachment[]
  ): void
  removeAttachment(sourceKey: string, id: string): void
  setSelection(sourceKey: string, selection: string): void
  useRecentContext(sourceKey: string): void
  ask(
    sourceKey: string,
    context: SideQuestionContextEntry[],
    source: SideQuestionSource
  ): Promise<void>
  cancel(sourceKey: string): void
  clear(sourceKey: string): void
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
    update(sourceKey, {
      status: "cancelled",
      error: null,
      turns: get().bySource[sourceKey].turns.map((turn) =>
        turn.id === job.requestId
          ? { ...turn, status: "cancelled", error: null }
          : turn
      ),
    })
    void cancelSideQuestionRequest(job.transport, job.requestId).catch(() => {})
  }

  return {
    bySource: {},
    setQuestion: (sourceKey, question) => update(sourceKey, { question }),
    addAttachments: (sourceKey, attachments) =>
      update(sourceKey, {
        attachments: [
          ...(get().bySource[sourceKey]?.attachments ?? []),
          ...attachments,
        ],
      }),
    removeAttachment: (sourceKey, id) =>
      update(sourceKey, {
        attachments: (get().bySource[sourceKey]?.attachments ?? []).filter(
          (item) => item.id !== id
        ),
      }),
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
        // 显式刷新引用范围即开启新话题，不能把旧旁问历史混入新的主线快照。
        turns: [],
        contextSnapshot: null,
        selection: "",
        status: "idle",
        result: null,
        error: null,
        askedQuestion: null,
        askedAttachments: [],
      })
    },
    cancel,
    clear: (sourceKey) => {
      cancel(sourceKey)
      update(sourceKey, { ...EMPTY_SIDE_QUESTION })
    },
    ask: async (sourceKey, context, source) => {
      if (pending.has(sourceKey)) return
      const entry = get().bySource[sourceKey] ?? EMPTY_SIDE_QUESTION
      const question = entry.question.trim()
      if (!question && entry.attachments.length === 0) return
      const job = { requestId: randomUUID(), transport: getTransport() }
      // 追问沿用首次引用的主线快照，避免主线继续输出时悄悄改变讨论依据。
      const contextSnapshot =
        entry.contextSnapshot ??
        (entry.selection ? [] : context.map((item) => ({ ...item })))
      const completed = entry.turns.flatMap(
        (turn): SideQuestionContextEntry[] =>
          turn.status === "done" && turn.result
            ? [
                { role: "user", text: turn.question },
                { role: "assistant", text: turn.result.answer },
              ]
            : []
      )
      const history: SideQuestionContextEntry[] = []
      let remaining = SIDE_QUESTION_MAX_CONTEXT_CHARS
      // 只裁剪发给模型的近期历史；界面保留原文，按 Unicode 字符避免拆开表情。
      for (
        let index = completed.length - 1;
        index >= 0 &&
        history.length < SIDE_QUESTION_MAX_MESSAGES &&
        remaining > 0;
        index -= 1
      ) {
        const item = completed[index]
        const chars = Array.from(item.text.trim())
        if (chars.length === 0) continue
        const kept = chars.slice(-remaining)
        history.push({ role: item.role, text: kept.join("") })
        remaining -= kept.length
      }
      history.reverse()
      const turn: SideQuestionTurn = {
        id: job.requestId,
        question,
        attachments: [...entry.attachments],
        status: "loading",
        result: null,
        error: null,
      }
      pending.set(sourceKey, job)
      update(sourceKey, {
        turns: [...entry.turns, turn],
        contextSnapshot,
        question: "",
        attachments: [],
        status: "loading",
        askedQuestion: question,
        askedAttachments: turn.attachments,
        result: null,
        error: null,
      })
      const finishTurn = (patch: Partial<SideQuestionTurn>) =>
        get().bySource[sourceKey].turns.map((item) =>
          item.id === job.requestId ? { ...item, ...patch } : item
        )
      try {
        const result = await askSideQuestion(job.transport, {
          requestId: job.requestId,
          question,
          selection: entry.selection || null,
          context: contextSnapshot,
          history,
          attachments: turn.attachments.map(sideAttachmentPayload),
          sourceConnectionId: source.sourceConnectionId,
          sourceConversationId: source.sourceConversationId,
          sourceAgentType: source.sourceAgentType,
        })
        if (pending.get(sourceKey) !== job) return
        update(sourceKey, {
          status: "done",
          result,
          turns: finishTurn({ status: "done", result }),
        })
      } catch (error) {
        if (pending.get(sourceKey) !== job) return
        const message = toErrorMessage(error)
        const current = get().bySource[sourceKey]
        // 发送失败时恢复可编辑输入，但不能覆盖等待期间用户新写的草稿。
        const retryDraft =
          !current.question && current.attachments.length === 0
            ? { question, attachments: turn.attachments }
            : {}
        update(sourceKey, {
          ...retryDraft,
          status: "error",
          error: message,
          turns: finishTurn({ status: "error", error: message }),
        })
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

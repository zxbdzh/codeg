import { create } from "zustand"
import type { AgentType, PromptDraft } from "@/lib/types"
import { getActiveRemoteConnectionId } from "@/lib/transport"
import { registerBackendScopedStoreReset } from "./backend-scoped-store-reset"

export interface SideQuestionTarget {
  conversationId: number
  parentConversationId: number
  agentType: AgentType
  folderId: number
  workingDir: string | null
  readonly: boolean
  initialSend: {
    draft: PromptDraft
    modeId: string | null
    token: string
  } | null
  lastInitialSendToken?: string
}

interface SideQuestionPanelState {
  opened: Record<number, SideQuestionTarget>
  selectedByParent: Record<number, number>
  hydrated: boolean
  open: (
    target: Omit<SideQuestionTarget, "initialSend"> & {
      initialSend?: SideQuestionTarget["initialSend"]
    }
  ) => void
  consumeInitialSend: (id: number, token: string) => void
  forget: (id: number) => void
  hydrate: () => void
  reset: () => void
}

function storageKey() {
  // Web 由 origin 隔离；桌面远端窗口共享 localStorage，必须加连接身份。
  const remote = getActiveRemoteConnectionId()
  return `workspace:side-question-selection:${remote == null ? "local" : `remote-${remote}`}`
}

function readSelections(): Record<number, number> {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(storageKey()) ?? "{}"
    )
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value).filter(
        ([parent, id]) =>
          /^[1-9]\d*$/.test(parent) &&
          Number.isSafeInteger(Number(parent)) &&
          typeof id === "number" &&
          Number.isSafeInteger(id) &&
          id > 0
      )
    )
  } catch {
    return {}
  }
}

function persist(selected: Record<number, number>) {
  try {
    // 只保存选择，不保存自动发送指令；重启不能重复执行上次的问题。
    localStorage.setItem(storageKey(), JSON.stringify(selected))
  } catch {
    // 存储禁用时仍允许本次会话使用旁问。
  }
}

export const useSideQuestionPanelStore = create<SideQuestionPanelState>(
  (set) => ({
    opened: {},
    selectedByParent: {},
    hydrated: false,
    open: (target) =>
      set((state) => {
        const { conversationId, parentConversationId, initialSend } = target
        const selectedByParent = {
          ...(state.hydrated ? state.selectedByParent : readSelections()),
          [parentConversationId]: conversationId,
        }
        const existing = state.opened[conversationId]
        // 历史重选只改变选择；同一个创建请求重试提交时，新 token 才携带首问。
        const openedTarget =
          initialSend && initialSend.token !== existing?.lastInitialSendToken
            ? {
                ...(existing ?? target),
                workingDir: existing?.workingDir || target.workingDir,
                initialSend,
                lastInitialSendToken: initialSend.token,
              }
            : (existing ?? { ...target, initialSend: null })
        persist(selectedByParent)
        return {
          hydrated: true,
          selectedByParent,
          opened: { ...state.opened, [conversationId]: openedTarget },
        }
      }),
    consumeInitialSend: (id, token) =>
      set((state) => {
        const target = state.opened[id]
        // 旧的消费回调不能把稍后提交的新首问清掉。
        if (target?.initialSend?.token !== token) return state
        return {
          opened: { ...state.opened, [id]: { ...target, initialSend: null } },
        }
      }),
    forget: (id) =>
      set((state) => {
        const opened = { ...state.opened }
        delete opened[id]
        for (const target of Object.values(state.opened)) {
          if (target.parentConversationId === id)
            delete opened[target.conversationId]
        }
        const selectedByParent = Object.fromEntries(
          Object.entries(state.selectedByParent).filter(
            ([parent, selected]) =>
              Number(parent) !== id &&
              selected !== id &&
              state.opened[selected]?.parentConversationId !== id
          )
        )
        persist(selectedByParent)
        return { opened, selectedByParent }
      }),
    hydrate: () =>
      set((state) =>
        state.hydrated
          ? state
          : {
              selectedByParent: readSelections(),
              hydrated: true,
            }
      ),
    reset: () => set({ opened: {}, selectedByParent: {}, hydrated: false }),
  })
)

registerBackendScopedStoreReset(() =>
  useSideQuestionPanelStore.getState().reset()
)

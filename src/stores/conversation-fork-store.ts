"use client"

import { create } from "zustand"
import type { ForkPromptSnapshot } from "@/lib/research-branch"
import { registerBackendScopedStoreReset } from "./backend-scoped-store-reset"

export interface ConversationForkTarget {
  conversationId: number
  unavailable:
    | "viewer"
    | "connectionRequired"
    | "connectionPending"
    | "waitForCompletion"
    | "unsupported"
    | null
  onSelect: (
    turnId: string,
    text: string,
    fromStart?: boolean,
    sourcePrompt?: ForkPromptSnapshot
  ) => Promise<boolean>
}

interface ConversationForkStore {
  byTab: Record<string, ConversationForkTarget>
  register: (tabId: string, target: ConversationForkTarget) => () => void
}

export const useConversationForkStore = create<ConversationForkStore>(
  (set) => ({
    byTab: {},
    register: (tabId, target) => {
      set((state) => ({ byTab: { ...state.byTab, [tabId]: target } }))
      return () => {
        set((state) => {
          // 旧视图卸载不能清掉同一标签重新注册的新连接。
          if (state.byTab[tabId] !== target) return state
          const byTab = { ...state.byTab }
          delete byTab[tabId]
          return { byTab }
        })
      }
    },
  })
)

registerBackendScopedStoreReset(() =>
  useConversationForkStore.setState({ byTab: {} })
)

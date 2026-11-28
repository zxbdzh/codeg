"use client"

import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import {
  useAcpActions,
  useConnectionStore,
} from "@/contexts/acp-connections-context"
import { isConnectionBusy } from "@/lib/connection-teardown"
import { useTabStore } from "@/contexts/tab-context"
import { useSideQuestionSource } from "@/hooks/use-side-question-source"
import {
  useSideQuestionPanelStore,
  type SideQuestionTarget,
} from "@/stores/side-question-panel-store"
import { subscribe } from "@/lib/platform"
import { getActiveRemoteConnectionId } from "@/lib/transport"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { randomUUID } from "@/lib/utils"
import {
  clearSideQuestionDraft,
  loadSideQuestionDraft,
  saveSideQuestionDraft,
} from "@/lib/side-question-draft"
import type { PromptDraft } from "@/lib/types"
import {
  CONVERSATION_CHANGED_EVENT,
  type ConversationChange,
} from "@/lib/types"
import { CanvasConversationSurface } from "@/components/canvas/canvas-conversation-surface"

function SideQuestionSurface({
  target,
  visible,
}: {
  target: SideQuestionTarget
  visible: boolean
}) {
  // 同源存储由多个后端共享，挂载期间固定后端身份以隔离连接和草稿。
  const [backend] = useState(() => getActiveRemoteConnectionId())
  const key = `side-question-${JSON.stringify([backend, target.conversationId])}`
  const [recovery] = useState(() =>
    loadSideQuestionDraft(backend, "question", target.conversationId)
  )
  const t = useTranslations("Folder.sideQuestion")
  const questionId = target.conversationId
  const recoverSend = useCallback(
    (draft: PromptDraft, initialToken?: string) => {
      const saved = loadSideQuestionDraft(backend, "question", questionId)
      if (initialToken && saved?.token !== initialToken) return false
      if (!saved) return
      // 手动重试可以编辑原文；先保存新版本，旧回执不能把它清掉。
      const token = initialToken ?? randomUUID()
      if (
        !initialToken &&
        !saveSideQuestionDraft(backend, "question", questionId, {
          token,
          draft,
        })
      ) {
        toast.error(t("draftSaveFailed"))
        return false
      }
      return () =>
        clearSideQuestionDraft(backend, "question", questionId, token)
    },
    [backend, questionId, t]
  )
  const consumeInitialSend = useCallback(
    (token?: string) => {
      if (token)
        useSideQuestionPanelStore
          .getState()
          .consumeInitialSend(questionId, token)
    },
    [questionId]
  )
  const store = useConnectionStore()
  const { registerLiveSurfaceKeys } = useAcpActions()
  const busy = useSyncExternalStore(
    useCallback((listener) => store.subscribeKey(key, listener), [store, key]),
    useCallback(() => {
      const conn = store.getConnection(key)
      return !!conn && (conn.status === "connecting" || isConnectionBusy(conn))
    }, [store, key]),
    () => false
  )
  const keepAlive = visible || busy || target.initialSend != null
  useEffect(() => {
    // 后台回答保持心跳，已空闲的隐藏旁问交给现有回收器，避免进程无限积累。
    registerLiveSurfaceKeys(key, keepAlive ? new Set([key]) : new Set())
    return () => registerLiveSurfaceKeys(key, new Set())
  }, [key, keepAlive, registerLiveSurfaceKeys])
  return (
    <div
      className="min-h-0 flex-1 flex-col"
      style={{ display: visible ? "flex" : "none" }}
    >
      <CanvasConversationSurface
        contextKey={key}
        conversationId={target.conversationId}
        agentType={target.agentType}
        draftTarget={{
          kind: "folder",
          folderId: target.folderId,
          workingDir: target.workingDir ?? "",
        }}
        folderPickerOverride={{
          folderId: target.folderId,
          editable: false,
          onSelectFolder: () => {},
          onSelectChatMode: () => {},
        }}
        initialSend={target.initialSend}
        recoveryDraft={recovery?.draft}
        protectRecoverySend={recoverSend}
        onInitialSendConsumed={consumeInitialSend}
        readonlyAsk={target.readonly}
        connectInBackground={target.initialSend != null}
        isActive={visible}
        checksOpenInDrawer
      />
    </div>
  )
}

const DockContext = createContext<(element: HTMLDivElement | null) => void>(
  () => {}
)

export function SideQuestionDock() {
  const dock = useContext(DockContext)
  return <div ref={dock} className="flex min-h-0 flex-1 flex-col" />
}

/** 宿主位于桌面/移动布局之外；只移动同一个 DOM 容器，不重挂聊天和首问。 */
export function SideQuestionHost({ children }: { children: ReactNode }) {
  const [dock, setDock] = useState<HTMLDivElement | null>(null)
  const [container] = useState(() => {
    if (typeof document === "undefined") return null
    const element = document.createElement("div")
    element.className = "flex min-h-0 flex-1 flex-col"
    return element
  })
  const opened = useSideQuestionPanelStore((s) => s.opened)
  const selected = useSideQuestionPanelStore((s) => s.selectedByParent)
  const { parentId } = useSideQuestionSource()
  const { isOpen, activeTab } = useAuxPanelContext()
  const { setActiveKey } = useAcpActions()
  const visibleId =
    isOpen && activeTab === "side_question" && dock && parentId != null
      ? selected[parentId]
      : null

  useEffect(() => useSideQuestionPanelStore.getState().hydrate(), [])
  useEffect(() => {
    if (!container || !dock) return
    dock.appendChild(container)
    return () => container.remove()
  }, [container, dock])

  useEffect(() => {
    if (visibleId != null) return
    const mainKey = useTabStore.getState().activeTabId
    if (mainKey) setActiveKey(mainKey)
  }, [visibleId, setActiveKey])

  useEffect(() => {
    let disposed = false
    let off: (() => void) | undefined
    void subscribe<ConversationChange>(CONVERSATION_CHANGED_EVENT, (change) => {
      const state = useSideQuestionPanelStore.getState()
      if (change.kind === "deleted") {
        state.forget(change.id)
      } else if (change.kind === "upsert") {
        const { summary } = change
        const target = state.opened[summary.id]
        const selectedParent = Object.entries(state.selectedByParent).find(
          ([, id]) => id === summary.id
        )?.[0]
        const parent = target?.parentConversationId ?? Number(selectedParent)
        // 普通会话更新不得误删其子旁问，只有已知旁问转出原主线时才清理。
        if (
          (target || selectedParent !== undefined) &&
          (summary.kind !== "ask" || summary.parent_id !== parent)
        )
          state.forget(summary.id)
      }
    }).then((unsubscribe) => {
      if (disposed) unsubscribe()
      else off = unsubscribe
    })
    return () => {
      disposed = true
      off?.()
    }
  }, [])

  return (
    <DockContext.Provider value={setDock}>
      {children}
      {container &&
        createPortal(
          Object.values(opened).map((target) => (
            <SideQuestionSurface
              key={target.conversationId}
              target={target}
              visible={visibleId === target.conversationId}
            />
          )),
          container
        )}
    </DockContext.Provider>
  )
}

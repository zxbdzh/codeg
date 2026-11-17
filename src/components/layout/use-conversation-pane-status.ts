import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { useOptionalConnectionStore } from "@/contexts/acp-connections-context"
import { acpGetSessionSnapshotByConversation } from "@/lib/api"
import type { LiveSessionSnapshot } from "@/lib/types"
import {
  samePaneActivity,
  summarizeBackgroundPaneAttention,
  summarizePaneActivity,
  type PaneActivitySummary,
  type PaneAttentionSummary,
} from "@/lib/conversation-pane-status"
import { useTabStore } from "@/stores/tab-store"

/** 仅订阅当前 Pane 中打开标签的连接，不随消息正文或事件序号刷新。 */
export function useConversationPaneStatus(paneId: string | null) {
  const store = useOptionalConnectionStore()
  const tabs = useTabStore((state) => state.tabs)
  const paneState = useTabStore((state) => state.paneState)
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!store || !paneId) return () => {}
      const pane = paneState?.panes.find((item) => item.id === paneId)
      const tabIds = tabs
        .filter((tab) =>
          Object.prototype.hasOwnProperty.call(pane?.assignments ?? {}, tab.id)
        )
        .map((tab) => tab.id)
      const unsubscribe = tabIds.map((id) => store.subscribeKey(id, notify))
      return () => unsubscribe.forEach((fn) => fn())
    },
    [paneId, paneState, store, tabs]
  )
  const getSnapshot = useCallback(() => {
    const pane = paneState?.panes.find((item) => item.id === paneId)
    if (!pane) return null
    return summarizePaneActivity(pane, tabs, (id) => store?.getConnection(id))
  }, [paneId, paneState, store, tabs])
  // 聚合器每次返回新对象；缓存等值结果，避免无意义的状态事件触发重绘。
  const snapshot = useRef<{
    source: PaneActivitySummary | null
    result: PaneActivitySummary | null
  }>({ source: null, result: null })
  return useSyncExternalStore(
    subscribe,
    () => {
      const source = getSnapshot()
      if (!samePaneActivity(snapshot.current.source, source)) {
        snapshot.current = { source, result: source }
      }
      return snapshot.current.result
    },
    () => null
  )
}

const EMPTY_ATTENTION: PaneAttentionSummary[] = []
const PRESENCE_REFRESH_MS = 1500
const PRESENCE_CACHE_TTL_MS = 5000

interface BackgroundAttentionSnapshot {
  kind: PaneAttentionSummary["kind"] | "running" | null
  connectionId: string
  eventSeq: number
}

function attentionActivity(
  snapshot: LiveSessionSnapshot
): BackgroundAttentionSnapshot["kind"] {
  if (
    snapshot.pending_permission ||
    snapshot.pending_question ||
    snapshot.pending_plan_approval
  ) {
    return "waiting"
  }
  if (
    snapshot.status === "error" ||
    snapshot.last_error ||
    snapshot.session_failures?.some(
      (failure) => !failure.resolved && failure.severity === "error"
    )
  ) {
    return "error"
  }
  return snapshot.status === "prompting" ? "running" : null
}

/** 冷后台标签只读查询后端连接；不会为未选中的会话新建 Agent 进程。 */
export function useBackgroundPaneAttention() {
  const store = useOptionalConnectionStore()
  const tabs = useTabStore((state) => state.tabs)
  const paneState = useTabStore((state) => state.paneState)
  const snapshot = useRef(EMPTY_ATTENTION)
  const [presenceSnapshots, setPresenceSnapshots] = useState(
    () => new Map<string, BackgroundAttentionSnapshot>()
  )
  const presenceFreshAt = useRef(new Map<string, number>())
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!store || !paneState) return () => {}
      const backgroundIds = new Set(
        paneState.panes
          .filter((pane) => pane.id !== paneState.activePaneId)
          .flatMap((pane) => Object.keys(pane.assignments))
      )
      const unsubscribe = tabs
        .filter((tab) => backgroundIds.has(tab.id))
        .map((tab) => store.subscribeKey(tab.id, notify))
      return () => unsubscribe.forEach((dispose) => dispose())
    },
    [paneState, store, tabs]
  )
  useEffect(() => {
    if (!paneState || !store) return
    const backgroundTabs = tabs.filter((tab) =>
      paneState.panes.some(
        (pane) =>
          pane.id !== paneState.activePaneId &&
          Object.prototype.hasOwnProperty.call(pane.assignments, tab.id)
      )
    )
    let cancelled = false
    let refreshing = false
    const refresh = async () => {
      if (refreshing) return
      refreshing = true
      try {
        // 本地已有流仍可能在窄屏重挂载时落后；只读快照用连接 ID 和序号仲裁，
        // 不恢复历史、不建立新连接，也不发送提示词。
        const activeTabs = backgroundTabs.filter(
          (tab) =>
            tab.conversationId != null &&
            (tab.status === "in_progress" ||
              tab.status === "pending_review" ||
              store.getConnection(tab.id)?.status === "prompting")
        )
        const results: Array<{
          tabId: string
          snapshot: LiveSessionSnapshot | null | undefined
        }> = []
        for (let offset = 0; offset < activeTabs.length; offset += 4) {
          if (cancelled) return
          results.push(
            ...(await Promise.all(
              activeTabs.slice(offset, offset + 4).map(async (tab) => {
                try {
                  const result = await acpGetSessionSnapshotByConversation(
                    tab.conversationId!
                  )
                  return { tabId: tab.id, snapshot: result }
                } catch {
                  return { tabId: tab.id, snapshot: undefined }
                }
              })
            ))
          )
        }
        if (cancelled) return
        const now = Date.now()
        const updated = new Map<string, BackgroundAttentionSnapshot>()
        const failed = new Set<string>()
        for (const { tabId, snapshot: result } of results) {
          if (result === undefined) {
            failed.add(tabId)
            continue
          }
          if (!result) continue
          presenceFreshAt.current.set(tabId, now)
          updated.set(tabId, {
            kind: attentionActivity(result),
            connectionId: result.connection_id,
            eventSeq: result.event_seq,
          })
        }
        // 请求失败不立刻伪装成已解决；仅保留短时有效缓存，超时后清除。
        setPresenceSnapshots((previous) => {
          for (const tabId of failed) {
            const cached = previous.get(tabId)
            const freshAt = presenceFreshAt.current.get(tabId) ?? 0
            if (cached && now - freshAt <= PRESENCE_CACHE_TTL_MS) {
              updated.set(tabId, cached)
            }
          }
          const changed =
            previous.size !== updated.size ||
            [...updated].some(([tabId, value]) => {
              const cached = previous.get(tabId)
              return (
                cached?.kind !== value.kind ||
                cached?.connectionId !== value.connectionId ||
                cached?.eventSeq !== value.eventSeq
              )
            })
          return changed ? updated : previous
        })
      } finally {
        refreshing = false
      }
    }

    void refresh()
    const timer = window.setInterval(() => void refresh(), PRESENCE_REFRESH_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [paneState, store, tabs])

  const getSnapshot = useCallback(() => {
    const combined = summarizeBackgroundPaneAttention(
      paneState,
      tabs,
      (id) => store?.getConnection(id),
      (tabId) => {
        const cached = presenceSnapshots.get(tabId)
        if (!cached) return undefined
        const connection = store?.getConnection(tabId)
        if (
          !connection ||
          connection.status === "disconnected" ||
          (cached.connectionId === connection.connectionId &&
            cached.eventSeq > connection.lastAppliedSeq)
        ) {
          return cached.kind
        }
        return undefined
      }
    )
    // 连接还会广播流式正文；提醒内容未变时复用引用，避免整座灵动岛跟着重绘。
    if (
      snapshot.current.length !== combined.length ||
      combined.some((notice, index) => {
        const previous = snapshot.current[index]
        return (
          !samePaneActivity(previous, notice) ||
          previous.paneId !== notice.paneId ||
          previous.paneName !== notice.paneName ||
          previous.tabId !== notice.tabId
        )
      })
    ) {
      snapshot.current = combined
    }
    return snapshot.current
  }, [paneState, presenceSnapshots, store, tabs])
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_ATTENTION)
}

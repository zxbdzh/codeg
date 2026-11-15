import { useCallback, useRef, useSyncExternalStore } from "react"
import { useOptionalConnectionStore } from "@/contexts/acp-connections-context"
import {
  samePaneActivity,
  summarizePaneActivity,
  type PaneActivitySummary,
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

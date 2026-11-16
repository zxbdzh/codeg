"use client"

import { useCallback, useSyncExternalStore } from "react"
import { useOptionalConnectionStore } from "@/contexts/acp-connections-context"
import { connectionActivityKind } from "@/lib/conversation-pane-status"
import type { ConversationStatus } from "@/lib/types"

export function useConnectionActivity(
  contextKey: string,
  manualStatus?: ConversationStatus
) {
  const store = useOptionalConnectionStore()
  const subscribe = useCallback(
    (notify: () => void) =>
      store?.subscribeKey(contextKey, notify) ?? (() => {}),
    [contextKey, store]
  )
  const getSnapshot = useCallback(
    () =>
      connectionActivityKind(store?.getConnection(contextKey), manualStatus),
    [contextKey, manualStatus, store]
  )
  const getServerSnapshot = useCallback(
    () => connectionActivityKind(undefined, manualStatus),
    [manualStatus]
  )
  // 只订阅活动分类，流式正文和事件序号变化不能让列表、标签页跟着重绘。
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

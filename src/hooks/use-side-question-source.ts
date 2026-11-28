"use client"

import { useTabStore } from "@/contexts/tab-context"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

/** 只订阅身份信息，旁问栏不随主会话每个流式 token 重绘。 */
export function useSideQuestionSource() {
  const tab = useTabStore((s) =>
    s.tabs.find((item) => item.id === s.activeTabId)
  )
  const runtimeId = tab?.runtimeConversationId ?? tab?.conversationId
  const runtimeSummary = useConversationRuntimeStore((s) =>
    runtimeId == null
      ? undefined
      : s.byConversationId.get(runtimeId)?.detail?.summary
  )
  const listed = useAppWorkspaceStore((s) =>
    s.conversations.find((item) => item.id === tab?.conversationId)
  )
  const summary = runtimeSummary ?? listed
  const parentId =
    summary?.kind === "ask" ? summary.parent_id : tab?.conversationId
  return {
    parentId: parentId ?? null,
    status: tab?.status ?? summary?.status,
  }
}

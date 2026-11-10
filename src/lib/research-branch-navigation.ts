import { getFolderConversation } from "@/lib/api"
import { parkResearchSummary } from "@/lib/research-summary-handoff"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabStore } from "@/stores/tab-store"

export async function openResearchConversation(
  conversationId: number,
  besideConversationId?: number
): Promise<void> {
  const known = useAppWorkspaceStore
    .getState()
    .conversations.find((conversation) => conversation.id === conversationId)
  const summary = known ?? (await getFolderConversation(conversationId)).summary
  const store = useTabStore.getState()
  const beside = store.rawTabs.find(
    (tab) => tab.conversationId === besideConversationId
  )
  if (beside) store.switchTab(beside.id)
  store.openTab(
    summary.folder_id,
    summary.id,
    summary.agent_type,
    true,
    summary.title ?? undefined
  )
  if (!beside) return
  const target = useTabStore
    .getState()
    .rawTabs.find((tab) => tab.conversationId === conversationId)
  if (target)
    useTabStore.getState().splitExistingConversation(target.id, beside.id)
}

export async function returnResearchSummary(
  sourceConversationId: number,
  summary: string
): Promise<void> {
  await openResearchConversation(sourceConversationId)
  parkResearchSummary(sourceConversationId, summary)
}

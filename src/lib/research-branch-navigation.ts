import { getFolderConversation } from "@/lib/api"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabStore } from "@/stores/tab-store"

export async function openForkConversation(
  conversationId: number
): Promise<void> {
  const known = useAppWorkspaceStore
    .getState()
    .conversations.find((conversation) => conversation.id === conversationId)
  const summary = known ?? (await getFolderConversation(conversationId)).summary
  const store = useTabStore.getState()
  store.openTab(
    summary.folder_id,
    summary.id,
    summary.agent_type,
    true,
    summary.title ?? undefined
  )
}

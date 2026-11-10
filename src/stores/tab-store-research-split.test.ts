import { beforeEach, describe, expect, it, vi } from "vitest"

import { leafIds } from "@/lib/tab-group-layout"
import type { FolderDetail } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import { resetTabStore, useTabStore, type TabItemInternal } from "./tab-store"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

function tab(id: number): TabItemInternal {
  return {
    id: `conv-1-claude_code-${id}`,
    kind: "conversation",
    folderId: 1,
    conversationId: id,
    agentType: "claude_code",
    title: `conversation-${id}`,
    isPinned: true,
  }
}

beforeEach(() => {
  resetTabStore()
  resetAppWorkspaceStore()
  const folder = { id: 1, name: "repo", path: "/repo" } as FolderDetail
  useAppWorkspaceStore.setState({ folders: [folder], allFolders: [folder] })
  useTabStore.setState({ rawTabs: [tab(1), tab(2)], activeTabId: tab(1).id })
})

describe("research branch split", () => {
  it("opens the existing branch beside its source without creating a draft", () => {
    useTabStore.getState().splitExistingConversation(tab(2).id, tab(1).id)
    const state = useTabStore.getState()
    expect(state.rawTabs.map((item) => item.conversationId)).toEqual([1, 2])
    expect(leafIds(state.groupLayout)).toHaveLength(2)
    expect(state.activeTabId).toBe(tab(2).id)
    expect(state.groupOf[tab(2).id]).not.toBe(
      state.groupOf[tab(1).id] ?? "g-main"
    )
  })

  it("reuses an existing split and does not add another group", () => {
    const store = useTabStore.getState()
    store.splitExistingConversation(tab(2).id, tab(1).id)
    store.splitExistingConversation(tab(2).id, tab(1).id)
    expect(leafIds(useTabStore.getState().groupLayout)).toHaveLength(2)
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"

import { getFolderConversation } from "@/lib/api"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { resetTabStore, useTabStore } from "@/stores/tab-store"
import { openForkConversation } from "./research-branch-navigation"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

function summary(id: number): DbConversationSummary {
  return {
    id,
    folder_id: 1,
    agent_type: "claude_code",
    title: `conversation-${id}`,
    title_locked: true,
    status: "pending_review",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: `session-${id}`,
    message_count: 2,
    child_count: 0,
    created_at: "2026-11-10T00:00:00Z",
    updated_at: "2026-11-10T00:00:00Z",
    pinned_at: null,
  }
}

beforeEach(() => {
  resetTabStore()
  resetAppWorkspaceStore()
  vi.mocked(getFolderConversation).mockReset()
  const folder = { id: 1, name: "repo", path: "/repo" } as FolderDetail
  useAppWorkspaceStore.setState({
    folders: [folder],
    allFolders: [folder],
    conversations: [summary(1), summary(2)],
  })
  useTabStore.getState().openTab(1, 1, "claude_code", true)
})

describe("fork navigation", () => {
  it("keeps the source conversation open and opens the fork as a normal tab", async () => {
    await openForkConversation(2)
    const state = useTabStore.getState()
    expect(state.rawTabs.map((tab) => tab.conversationId)).toEqual([1, 2])
    expect(getFolderConversation).not.toHaveBeenCalled()
  })
})

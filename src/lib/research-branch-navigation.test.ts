import { beforeEach, describe, expect, it, vi } from "vitest"

import { getFolderConversation } from "@/lib/api"
import { leafIds } from "@/lib/tab-group-layout"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { resetTabStore, useTabStore } from "@/stores/tab-store"
import {
  openResearchConversation,
  returnResearchSummary,
} from "./research-branch-navigation"
import {
  clearResearchSummaryHandoffs,
  consumeResearchSummaries,
} from "./research-summary-handoff"

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
  clearResearchSummaryHandoffs()
  vi.mocked(getFolderConversation).mockReset()
  const folder = { id: 1, name: "repo", path: "/repo" } as FolderDetail
  useAppWorkspaceStore.setState({
    folders: [folder],
    allFolders: [folder],
    conversations: [summary(1), summary(2)],
  })
  useTabStore.getState().openTab(1, 1, "claude_code", true)
})

describe("research navigation", () => {
  it("keeps both conversations open and splits beside the source", async () => {
    await openResearchConversation(2, 1)
    const state = useTabStore.getState()
    expect(state.rawTabs.map((tab) => tab.conversationId)).toEqual([1, 2])
    expect(leafIds(state.groupLayout)).toHaveLength(2)
    expect(getFolderConversation).not.toHaveBeenCalled()
  })

  it("hands the chosen summary back as a draft without sending it", async () => {
    await openResearchConversation(2, 1)
    await returnResearchSummary(1, "chosen conclusion")
    const state = useTabStore.getState()
    expect(
      state.rawTabs.find((tab) => tab.id === state.activeTabId)?.conversationId
    ).toBe(1)
    expect(consumeResearchSummaries(1)).toEqual(["chosen conclusion"])
    expect(consumeResearchSummaries(2)).toEqual([])
    expect(getFolderConversation).not.toHaveBeenCalled()
  })
})

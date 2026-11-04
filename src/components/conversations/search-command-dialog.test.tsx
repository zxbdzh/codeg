import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { SearchCommandDialog } from "./search-command-dialog"
import enMessages from "@/i18n/messages/en.json"
import { listAllConversations } from "@/lib/api"
import type { ConversationTagDetail, DbConversationSummary } from "@/lib/types"
import type { FlatFileEntry } from "@/hooks/use-file-tree"

// The active folder and its conversations, per test: the agent filter chips
// only render once the folder holds more than one agent type.
const workspace = vi.hoisted(() => ({
  activeFolderId: null as number | null,
  conversations: [] as { folder_id: number; agent_type: string }[],
  tags: [] as ConversationTagDetail[],
  files: [] as FlatFileEntry[],
  resetFileTree: vi.fn(),
  openTab: vi.fn(),
  openConversations: vi.fn(),
  onOpenChange: vi.fn(),
}))

vi.mock("@/components/agent-icon", () => ({ AgentIcon: () => null }))

vi.mock("@/lib/api", () => ({
  listAllConversations: vi.fn(async () => []),
}))

vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTab: workspace.openTab }),
}))

vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ openConversations: workspace.openConversations }),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({ openFilePreview: vi.fn() }),
}))

vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => ({ revealInFileTree: vi.fn() }),
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({
    activeFolder: null,
    activeFolderId: workspace.activeFolderId,
  }),
}))

vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({ conversations: workspace.conversations }),
}))
vi.mock("@/stores/conversation-tags-store", () => ({
  useConversationTagsStore: (selector: (state: unknown) => unknown) =>
    selector({
      tags: workspace.tags,
      tagsById: new Map(workspace.tags.map((tag) => [tag.id, tag])),
    }),
}))

vi.mock("@/hooks/use-file-tree", () => ({
  useFileTree: () => ({
    allFiles: workspace.files,
    loading: false,
    reset: workspace.resetFileTree,
  }),
}))

function renderDialog(open = true) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SearchCommandDialog open={open} onOpenChange={workspace.onOpenChange} />
    </NextIntlClientProvider>
  )
}

function conversation(
  id: number,
  overrides: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  return {
    id,
    folder_id: 1,
    title: `Conversation ${id}`,
    title_locked: false,
    agent_type: "claude_code",
    status: "completed",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 1,
    child_count: 0,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    pinned_at: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  workspace.activeFolderId = null
  workspace.conversations = []
  workspace.tags = []
  workspace.files = []
  vi.mocked(listAllConversations).mockReset().mockResolvedValue([])
})

describe("SearchCommandDialog title and tag search", () => {
  beforeEach(() => {
    workspace.activeFolderId = 1
    workspace.tags = [
      {
        id: 4,
        name: "数字人",
        folder_id: null,
        color: "#8250df",
        sort_order: 1,
      },
    ]
    workspace.conversations = [
      conversation(1, { title: "跨多轮主线", tag_ids: [4] }),
      conversation(2, { title: "数字人调研", agent_type: "codex" }),
      conversation(3, { title: "库存管理" }),
    ]
    vi.mocked(listAllConversations).mockResolvedValue(
      workspace.conversations as DbConversationSummary[]
    )
  })

  it("finds a conversation by a mistyped tag even when the title does not match", async () => {
    renderDialog()
    const input = screen.getByPlaceholderText(
      enMessages.Folder.search.placeholder
    )
    fireEvent.change(input, { target: { value: "数子人" } })
    const result = await screen.findByRole("option", { name: /跨多轮主线/ })
    expect(within(result).getByText("数字人")).toBeVisible()
    expect(screen.queryByRole("option", { name: /库存管理/ })).toBeNull()
    expect(screen.queryByRole("option", { name: /数字人调研/ })).toBeNull()
    expect(listAllConversations).toHaveBeenCalledWith({ folder_ids: [1] })

    await userEvent.keyboard("{ArrowDown}{Enter}")
    expect(workspace.openTab).toHaveBeenCalledWith(1, 1, "claude_code", true)
    expect(workspace.openConversations).toHaveBeenCalledOnce()
    expect(workspace.onOpenChange).toHaveBeenCalledWith(false)
  })

  it("searches titles and tags together and applies the agent filter to both", async () => {
    renderDialog()
    const input = screen.getByPlaceholderText(
      enMessages.Folder.search.placeholder
    )
    fireEvent.change(input, { target: { value: "数字人" } })
    await screen.findByRole("option", { name: /跨多轮主线/ })
    expect(screen.getAllByRole("option")).toHaveLength(2)
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("数字人调研")
    await userEvent.click(screen.getByRole("button", { name: "Codex" }))
    expect(screen.getAllByRole("option")).toHaveLength(1)
    expect(screen.getByRole("option")).toHaveTextContent("数字人调研")
    expect(input).toHaveFocus()
    expect(listAllConversations).toHaveBeenCalledOnce()
  })

  it.each(["shuziren", "szr"])(
    "finds tag matches from the unified search box with %s",
    async (query) => {
      renderDialog()
      fireEvent.change(
        screen.getByPlaceholderText(enMessages.Folder.search.placeholder),
        { target: { value: query } }
      )
      const result = await screen.findByRole("option", { name: /跨多轮主线/ })
      expect(within(result).getByText("数字人")).toBeVisible()
      expect(screen.queryByRole("option", { name: /库存管理/ })).toBeNull()
    }
  )

  it("keeps empty queries blank, clears old matches, and shows no results", async () => {
    renderDialog()
    await waitFor(() => expect(listAllConversations).toHaveBeenCalledOnce())
    expect(screen.queryAllByRole("option")).toHaveLength(0)
    const input = screen.getByPlaceholderText(
      enMessages.Folder.search.placeholder
    )
    fireEvent.change(input, { target: { value: "数人" } })
    await screen.findByRole("option", { name: /跨多轮主线/ })
    fireEvent.change(input, { target: { value: "no-such-tag" } })
    expect(screen.queryAllByRole("option")).toHaveLength(0)
    expect(screen.getByText(enMessages.Folder.search.noResults)).toBeVisible()
  })

  it("does not fetch conversation candidates while closed", () => {
    renderDialog(false)
    expect(listAllConversations).not.toHaveBeenCalled()
  })

  it("starts with an empty query after closing and reopening externally", async () => {
    const view = renderDialog()
    const input = screen.getByPlaceholderText(
      enMessages.Folder.search.placeholder
    )
    fireEvent.change(input, { target: { value: "数字人" } })
    await screen.findByRole("option", { name: /跨多轮主线/ })
    const dialog = (open: boolean) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SearchCommandDialog
          open={open}
          onOpenChange={workspace.onOpenChange}
        />
      </NextIntlClientProvider>
    )
    view.rerender(dialog(false))
    expect(screen.queryByRole("dialog")).toBeNull()
    view.rerender(dialog(true))
    expect(
      screen.getByPlaceholderText(enMessages.Folder.search.placeholder)
    ).toHaveValue("")
    expect(screen.queryAllByRole("option")).toHaveLength(0)
  })

  it("keeps fuzzy file search independent of conversation tag matching", async () => {
    workspace.files = [
      {
        name: "README.md",
        relativePath: "docs/README.md",
        kind: "file",
        lowerName: "readme.md",
        lowerPath: "docs/readme.md",
      },
    ]
    renderDialog()
    await userEvent.click(
      screen.getByRole("button", { name: enMessages.Folder.search.tabFiles })
    )
    const input = screen.getByPlaceholderText(
      enMessages.Folder.search.filePlaceholder
    )
    fireEvent.change(input, { target: { value: "rdm" } })
    expect(
      await screen.findByRole("option", { name: /README.md/ })
    ).toBeVisible()
    expect(input).toHaveFocus()
  })

  it("discards an old folder response after changing folders", async () => {
    let resolveOld!: (rows: DbConversationSummary[]) => void
    vi.mocked(listAllConversations)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve
          })
      )
      .mockResolvedValueOnce([
        conversation(9, { title: "新文件夹", folder_id: 2, tag_ids: [4] }),
      ])
    const view = renderDialog()
    await waitFor(() => expect(listAllConversations).toHaveBeenCalledOnce())
    const input = screen.getByPlaceholderText(
      enMessages.Folder.search.placeholder
    )
    fireEvent.change(input, { target: { value: "数字人" } })
    workspace.activeFolderId = 2
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SearchCommandDialog open onOpenChange={workspace.onOpenChange} />
      </NextIntlClientProvider>
    )
    await screen.findByRole("option", { name: /新文件夹/ })
    await act(async () => {
      resolveOld([conversation(1, { title: "旧文件夹", tag_ids: [4] })])
    })
    expect(screen.queryByRole("option", { name: /旧文件夹/ })).toBeNull()
    expect(screen.getByRole("option", { name: /新文件夹/ })).toBeVisible()
  })
})

describe("SearchCommandDialog focus", () => {
  beforeEach(() => {
    workspace.activeFolderId = null
    workspace.conversations = []
  })

  it("opens with the cursor in the search box, so typing searches", async () => {
    const user = userEvent.setup()
    renderDialog()

    const input = await screen.findByPlaceholderText(
      enMessages.Folder.search.placeholder
    )
    expect(input).toHaveFocus()

    await user.keyboard("auth")
    expect(input).toHaveValue("auth")
  })

  it("keeps the cursor in the search box when switching tabs", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(
      screen.getByRole("button", { name: enMessages.Folder.search.tabFiles })
    )

    expect(
      await screen.findByPlaceholderText(
        enMessages.Folder.search.filePlaceholder
      )
    ).toHaveFocus()
  })

  it("keeps the cursor in the search box when picking an agent filter", async () => {
    workspace.activeFolderId = 1
    workspace.conversations = [
      { folder_id: 1, agent_type: "claude_code" },
      { folder_id: 1, agent_type: "codex" },
    ]
    const user = userEvent.setup()
    renderDialog()

    const input = await screen.findByPlaceholderText(
      enMessages.Folder.search.placeholder
    )
    await user.click(screen.getByRole("button", { name: "Codex" }))
    expect(input).toHaveFocus()

    await user.click(
      screen.getByRole("button", { name: enMessages.Folder.search.allAgents })
    )
    expect(input).toHaveFocus()
  })

  it("pulls the cursor back when the chat composer behind it takes focus", async () => {
    // The composer refocuses itself when an agent turn ends, whether or not
    // the dialog is open over it. The dialog's focus trap must bring the
    // cursor back, or the rest of the query is typed into the composer.
    const composer = document.createElement("textarea")
    document.body.appendChild(composer)
    try {
      const user = userEvent.setup()
      renderDialog()

      const input = await screen.findByPlaceholderText(
        enMessages.Folder.search.placeholder
      )
      act(() => composer.focus())
      expect(input).toHaveFocus()

      await user.keyboard("auth")
      expect(input).toHaveValue("auth")
      expect(composer).toHaveValue("")
    } finally {
      composer.remove()
    }
  })
})

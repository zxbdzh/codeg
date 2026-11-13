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
import { listAllConversations, searchWorkspaceFiles } from "@/lib/api"
import { useFolderTabsStore } from "@/stores/folder-tabs-store"
import type {
  ConversationTagDetail,
  DbConversationSummary,
  FolderDetail,
} from "@/lib/types"
import type { FlatFileEntry } from "@/hooks/use-file-tree"

// The active folder and its conversations, per test: the agent filter chips
// only render once the folder holds more than one agent type.
const workspace = vi.hoisted(() => ({
  activeFolderId: null as number | null,
  folders: [] as FolderDetail[],
  conversations: [] as { folder_id: number; agent_type: string }[],
  tags: [] as ConversationTagDetail[],
  files: [] as FlatFileEntry[],
  filesLoaded: true,
  openFilePreview: vi.fn(),
  revealInFileTree: vi.fn(),
  openTab: vi.fn(),
  openConversations: vi.fn(),
  onOpenChange: vi.fn(),
}))

vi.mock("@/components/agent-icon", () => ({ AgentIcon: () => null }))

vi.mock("@/lib/api", () => ({
  listAllConversations: vi.fn(async () => []),
  searchWorkspaceFiles: vi.fn(),
}))

vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTab: workspace.openTab }),
}))

vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ openConversations: workspace.openConversations }),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({ openFilePreview: workspace.openFilePreview }),
}))

vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => ({ revealInFileTree: workspace.revealInFileTree }),
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({
    activeFolder:
      workspace.activeFolderId === null
        ? null
        : {
            id: workspace.activeFolderId,
            name: `Project ${workspace.activeFolderId}`,
            path: `/repo-${workspace.activeFolderId}`,
          },
    activeFolderId: workspace.activeFolderId,
  }),
}))

vi.mock("@/stores/app-workspace-store", () => {
  const snapshot = () => ({
    conversations: workspace.conversations,
    allFolders: workspace.folders,
  })
  return {
    useAppWorkspaceStore: Object.assign(
      (selector: (state: unknown) => unknown) => selector(snapshot()),
      { getState: snapshot }
    ),
  }
})
vi.mock("@/stores/conversation-tags-store", () => ({
  useConversationTagsStore: (selector: (state: unknown) => unknown) =>
    selector({
      tags: workspace.tags,
      tagsById: new Map(workspace.tags.map((tag) => [tag.id, tag])),
    }),
}))

function renderDialog(open = true, initialTab?: "all") {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SearchCommandDialog
        open={open}
        onOpenChange={workspace.onOpenChange}
        initialTab={initialTab}
      />
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
  workspace.folders = [1, 2].map((id) => ({
    id,
    name: `Project ${id}`,
    path: `/repo-${id}`,
    git_branch: null,
    default_agent_type: null,
    last_opened_at: "2026-11-01T00:00:00Z",
    sort_order: id,
    color: "inherit",
    parent_id: null,
    kind: "regular" as const,
    alias: null,
    group_id: null,
  }))
  workspace.conversations = []
  workspace.tags = []
  workspace.files = []
  workspace.filesLoaded = true
  vi.mocked(listAllConversations).mockReset().mockResolvedValue([])
  vi.mocked(searchWorkspaceFiles)
    .mockReset()
    .mockImplementation(async (path) => {
      if (!workspace.filesLoaded) return new Promise(() => {})
      return workspace.files
        .filter((entry) => !entry.folderPath || entry.folderPath === path)
        .map((entry) => ({
          name: entry.name,
          path: entry.relativePath,
          kind: entry.kind,
        }))
    })
  useFolderTabsStore.setState({ enabled: false, scope: "global" })
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
    await waitFor(() => expect(listAllConversations).toHaveBeenCalledTimes(2))
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

describe("SearchCommandDialog global search tab", () => {
  beforeEach(() => {
    workspace.activeFolderId = 1
    workspace.conversations = [
      conversation(1, { title: "auth flow" }),
      conversation(2, { title: "auth style", agent_type: "codex" }),
      conversation(3, { title: "auth elsewhere", folder_id: 2 }),
    ]
    vi.mocked(listAllConversations).mockResolvedValue(
      workspace.conversations as DbConversationSummary[]
    )
    workspace.files = [
      {
        name: "auth.ts",
        relativePath: "src/auth.ts",
        kind: "file",
        lowerName: "auth.ts",
        lowerPath: "src/auth.ts",
      },
    ]
  })

  it("mixes conversations with files, scoped to the active folder", async () => {
    renderDialog(true, "all")

    fireEvent.change(
      screen.getByPlaceholderText(enMessages.Folder.search.allPlaceholder),
      { target: { value: "auth" } }
    )

    expect(
      await screen.findByRole("option", { name: /auth flow/ })
    ).toBeVisible()
    expect(screen.getByRole("option", { name: /auth style/ })).toBeVisible()
    expect(await screen.findByRole("option", { name: /auth.ts/ })).toBeVisible()
    // 别的项目文件夹里的会话不进入当前项目的全局搜索结果。
    expect(screen.queryByRole("option", { name: /auth elsewhere/ })).toBeNull()
  })

  it("only includes other projects after explicitly widening the scope", async () => {
    renderDialog(true, "all")
    const input = screen.getByPlaceholderText(
      enMessages.Folder.search.allPlaceholder
    )
    fireEvent.change(input, { target: { value: "auth" } })
    await screen.findByRole("option", { name: /auth flow/ })
    expect(screen.queryByRole("option", { name: /auth elsewhere/ })).toBeNull()

    await userEvent.click(screen.getByRole("button", { name: "All projects" }))

    const result = await screen.findByRole("option", { name: /auth elsewhere/ })
    expect(within(result).getByText("Project 2")).toBeVisible()
    expect(input).toHaveFocus()
    expect(listAllConversations).toHaveBeenLastCalledWith({
      folder_ids: [1, 2],
    })

    await userEvent.click(
      screen.getByRole("button", { name: "Current project" })
    )
    expect(screen.queryByRole("option", { name: /auth elsewhere/ })).toBeNull()
    expect(input).toHaveValue("auth")
  })

  it("does not search other projects when no project is selected", () => {
    workspace.activeFolderId = null
    renderDialog(true, "all")
    fireEvent.change(
      screen.getByPlaceholderText(enMessages.Folder.search.allPlaceholder),
      { target: { value: "auth" } }
    )
    expect(listAllConversations).not.toHaveBeenCalled()
    expect(screen.queryAllByRole("option")).toHaveLength(0)
  })

  it("hides the previous project's files until current files are loaded", async () => {
    workspace.filesLoaded = false
    renderDialog(true, "all")
    fireEvent.change(
      screen.getByPlaceholderText(enMessages.Folder.search.allPlaceholder),
      { target: { value: "auth" } }
    )
    await screen.findByRole("option", { name: /auth flow/ })
    expect(screen.queryByRole("option", { name: /auth.ts/ })).toBeNull()
  })

  it("drops the agent filter when switching to the unified tab", async () => {
    renderDialog()
    fireEvent.change(
      screen.getByPlaceholderText(enMessages.Folder.search.placeholder),
      { target: { value: "auth" } }
    )
    await screen.findByRole("option", { name: /auth flow/ })

    await userEvent.click(screen.getByRole("button", { name: "Codex" }))
    expect(screen.getAllByRole("option")).toHaveLength(1)

    await userEvent.click(
      screen.getByRole("button", { name: enMessages.Folder.search.tabAll })
    )
    // 筛选条在「全部」页不可见；若状态没清空，这里只会剩下 Codex 的会话。
    expect(screen.getByRole("option", { name: /auth flow/ })).toBeVisible()
    expect(screen.getByRole("option", { name: /auth style/ })).toBeVisible()
  })
})

describe("SearchCommandDialog project scope", () => {
  beforeEach(() => {
    workspace.activeFolderId = 1
    workspace.conversations = [
      conversation(1, { title: "auth current" }),
      conversation(2, { title: "auth other", folder_id: 2 }),
    ]
    vi.mocked(listAllConversations).mockResolvedValue(
      workspace.conversations as DbConversationSummary[]
    )
    workspace.files = [1, 2].map((id) => ({
      name: "auth.ts",
      relativePath: "src/auth.ts",
      kind: "file" as const,
      lowerName: "auth.ts",
      lowerPath: "src/auth.ts",
      folderPath: `/repo-${id}`,
    }))
  })

  it("keeps same-path files distinct and opens the selected project's file", async () => {
    useFolderTabsStore.setState({ enabled: true, scope: 1 })
    renderDialog(true, "all")
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "auth.ts" },
    })
    await screen.findByRole("option", { name: /auth.ts/ })
    expect(searchWorkspaceFiles).toHaveBeenCalledWith(
      "/repo-1",
      expect.any(String),
      expect.anything()
    )
    expect(
      vi
        .mocked(searchWorkspaceFiles)
        .mock.calls.some(([path]) => path === "/repo-2")
    ).toBe(false)

    await userEvent.click(screen.getByRole("button", { name: "All projects" }))
    const otherFile = await screen.findByRole("option", {
      name: /auth.ts Project 2/,
    })
    expect(screen.getAllByRole("option")).toHaveLength(2)
    await userEvent.click(otherFile)

    expect(workspace.openFilePreview).toHaveBeenCalledExactlyOnceWith(
      "src/auth.ts",
      { folderId: 2 }
    )
    expect(useFolderTabsStore.getState().scope).toBe(2)
    expect(workspace.revealInFileTree).not.toHaveBeenCalled()
    expect(workspace.onOpenChange).toHaveBeenCalledWith(false)
  })

  it("opens a conversation in the project shown on its result", async () => {
    renderDialog(true, "all")
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "auth other" },
    })
    await userEvent.click(screen.getByRole("button", { name: "All projects" }))
    await userEvent.click(
      await screen.findByRole("option", { name: /auth other/ })
    )
    expect(workspace.openTab).toHaveBeenCalledWith(2, 2, "claude_code", true)
    expect(workspace.openConversations).toHaveBeenCalledOnce()
  })

  it("allows all-project search without a current project, but never widens implicitly", async () => {
    workspace.activeFolderId = null
    renderDialog(true, "all")
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "auth" },
    })
    expect(listAllConversations).not.toHaveBeenCalled()
    expect(searchWorkspaceFiles).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "All projects" }))
    expect(
      await screen.findByRole("option", { name: /auth other/ })
    ).toBeVisible()
    expect(
      await screen.findByRole("option", { name: /auth.ts Project 2/ })
    ).toBeVisible()
  })

  it("does not include hidden chat folders in all projects", async () => {
    workspace.folders.push({
      ...workspace.folders[0],
      id: 3,
      path: "/chat",
      kind: "chat",
    })
    workspace.conversations.push(
      conversation(3, { title: "auth chat", folder_id: 3 })
    )
    renderDialog(true, "all")
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "auth" },
    })
    await userEvent.click(screen.getByRole("button", { name: "All projects" }))
    await screen.findByRole("option", { name: /auth other/ })
    expect(screen.queryByRole("option", { name: /auth chat/ })).toBeNull()
    expect(listAllConversations).toHaveBeenLastCalledWith({
      folder_ids: [1, 2],
    })
    expect(
      vi
        .mocked(searchWorkspaceFiles)
        .mock.calls.some(([path]) => path === "/chat")
    ).toBe(false)
  })

  it("never sends an unrestricted query when no projects are registered", async () => {
    workspace.activeFolderId = null
    workspace.folders = []
    renderDialog(true, "all")
    await userEvent.click(screen.getByRole("button", { name: "All projects" }))
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "auth" },
    })
    expect(listAllConversations).not.toHaveBeenCalled()
    expect(searchWorkspaceFiles).not.toHaveBeenCalled()
    expect(screen.queryAllByRole("option")).toHaveLength(0)
  })

  it("resets to the current project after closing and reopening", async () => {
    const view = renderDialog(true, "all")
    await userEvent.click(screen.getByRole("button", { name: "All projects" }))
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "auth" },
    })
    await screen.findByRole("option", { name: /auth other/ })
    const dialog = (open: boolean) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SearchCommandDialog
          open={open}
          onOpenChange={workspace.onOpenChange}
          initialTab="all"
        />
      </NextIntlClientProvider>
    )
    view.rerender(dialog(false))
    view.rerender(dialog(true))
    expect(
      screen.getByRole("button", { name: "Current project" })
    ).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("combobox")).toHaveValue("")
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "auth" },
    })
    await screen.findByRole("option", { name: /auth current/ })
    expect(screen.queryByRole("option", { name: /auth other/ })).toBeNull()
    expect(
      await screen.findAllByRole("option", { name: /auth.ts/ })
    ).toHaveLength(1)
  })

  it("ignores a late all-project response after narrowing back to the current project", async () => {
    let resolveAll!: (rows: DbConversationSummary[]) => void
    vi.mocked(listAllConversations)
      .mockResolvedValueOnce([conversation(1, { title: "auth current" })])
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveAll = resolve
          })
      )
      .mockResolvedValueOnce([conversation(1, { title: "auth current" })])
    renderDialog(true, "all")
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "auth" },
    })
    await screen.findByRole("option", { name: /auth current/ })
    await userEvent.click(screen.getByRole("button", { name: "All projects" }))
    await waitFor(() => expect(listAllConversations).toHaveBeenCalledTimes(2))
    await userEvent.click(
      screen.getByRole("button", { name: "Current project" })
    )
    await screen.findByRole("option", { name: /auth current/ })
    await act(async () =>
      resolveAll([conversation(2, { title: "auth other", folder_id: 2 })])
    )
    expect(screen.queryByRole("option", { name: /auth other/ })).toBeNull()
    expect(screen.getByRole("option", { name: /auth current/ })).toBeVisible()
  })

  it("shows successful project files when another project fails to load", async () => {
    vi.mocked(searchWorkspaceFiles).mockImplementation(async (path) => {
      if (path === "/repo-2") throw new Error("unavailable")
      return [{ name: "auth.ts", path: "src/auth.ts", kind: "file" }]
    })
    renderDialog(true, "all")
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "auth.ts" },
    })
    await userEvent.click(screen.getByRole("button", { name: "All projects" }))
    expect(
      await screen.findByRole("option", { name: /auth.ts Project 1/ })
    ).toBeVisible()
    expect(screen.getByRole("status")).toHaveTextContent(
      "Could not load files from 1 projects"
    )
  })

  it("ignores files arriving from an old all-project scan after narrowing the scope", async () => {
    let resolveOther!: (
      files: { name: string; path: string; kind: "file" }[]
    ) => void
    vi.mocked(searchWorkspaceFiles).mockImplementation(async (path) => {
      if (path === "/repo-2")
        return new Promise((resolve) => {
          resolveOther = resolve
        })
      return [{ name: "auth.ts", path: "src/auth.ts", kind: "file" }]
    })
    renderDialog(true, "all")
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "auth.ts" },
    })
    await screen.findByRole("option", { name: /auth.ts/ })
    await userEvent.click(screen.getByRole("button", { name: "All projects" }))
    await waitFor(() =>
      expect(
        vi
          .mocked(searchWorkspaceFiles)
          .mock.calls.some(([path]) => path === "/repo-2")
      ).toBe(true)
    )
    await userEvent.click(
      screen.getByRole("button", { name: "Current project" })
    )
    await screen.findByRole("option", { name: /auth.ts/ })
    await act(async () =>
      resolveOther([
        { name: "auth-other.ts", path: "auth-other.ts", kind: "file" },
      ])
    )
    expect(screen.queryByRole("option", { name: /auth-other.ts/ })).toBeNull()
    expect(screen.getAllByRole("option")).toHaveLength(1)
  })

  it("limits concurrent scans and eventually searches every registered project", async () => {
    workspace.folders = Array.from({ length: 6 }, (_, index) => ({
      ...workspace.folders[0],
      id: index + 1,
      name: `Project ${index + 1}`,
      path: `/repo-${index + 1}`,
    }))
    const scans: (() => void)[] = []
    let activeScans = 0
    let peakScans = 0
    vi.mocked(searchWorkspaceFiles).mockImplementation(() => {
      activeScans++
      peakScans = Math.max(peakScans, activeScans)
      return new Promise((resolve) => {
        scans.push(() => {
          activeScans--
          resolve([{ name: "auth.ts", path: "auth.ts", kind: "file" }])
        })
      })
    })
    renderDialog()
    await userEvent.click(screen.getByRole("button", { name: "All projects" }))
    await userEvent.click(screen.getByRole("button", { name: "Files" }))
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "auth.ts" },
    })
    await waitFor(() => expect(scans).toHaveLength(4))
    await act(async () => {
      scans.slice(0, 4).forEach((complete) => complete())
    })
    await waitFor(() => expect(scans).toHaveLength(6))
    await act(async () => {
      scans.slice(4).forEach((complete) => complete())
    })
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(6))
    expect(peakScans).toBe(4)
    expect(screen.getByRole("option", { name: /Project 6/ })).toBeVisible()
  })

  it("keeps directory matches in current-project search", async () => {
    workspace.files = [
      {
        name: "auth",
        relativePath: "src/auth",
        kind: "dir",
        lowerName: "auth",
        lowerPath: "src/auth",
      },
    ]
    renderDialog(true, "all")
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "src/auth" },
    })
    await userEvent.click(
      await screen.findByRole("option", { name: /src\/auth/ })
    )
    expect(workspace.revealInFileTree).toHaveBeenCalledWith("src/auth")
    expect(workspace.openFilePreview).not.toHaveBeenCalled()
  })

  it("reuses loaded project files when switching result categories", async () => {
    renderDialog(true, "all")
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "auth.ts" },
    })
    await screen.findByRole("option", { name: /auth.ts/ })
    await userEvent.click(screen.getByRole("button", { name: "Conversations" }))
    await userEvent.click(screen.getByRole("button", { name: "Files" }))
    await screen.findByRole("option", { name: /auth.ts/ })
    expect(searchWorkspaceFiles).toHaveBeenCalledTimes(1)
  })
})

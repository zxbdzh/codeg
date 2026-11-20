import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { CurationJob, CurationRequest } from "@/lib/tag-curation"
import type {
  ConversationBranchTag,
  ConversationTagDetail,
  FolderDetail,
} from "@/lib/types"

const h = vi.hoisted(() => ({
  tags: [] as ConversationTagDetail[],
  branchTag: { enabled: false, color: "#6e7781" } as ConversationBranchTag,
  requestCuration: vi.fn(),
  // Stores what it is given, as the backend would, for the reads after it.
  updateBranchTag: vi.fn(async (setting: ConversationBranchTag) => {
    h.branchTag = setting
    return setting
  }),
}))

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  listConversationTags: vi.fn(async () => h.tags),
  getConversationBranchTag: vi.fn(async () => h.branchTag),
  updateConversationBranchTag: h.updateBranchTag,
}))

vi.mock("@/lib/tag-curation", () => ({
  requestTagCuration: h.requestCuration,
}))

import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import {
  resetConversationTagsStore,
  useConversationTagsStore,
} from "@/stores/conversation-tags-store"
import {
  ConversationTagsManagerHost,
  openConversationTagsManager,
  resetConversationTagsManagerForTests,
} from "./conversation-tags-manager"

const tag = (
  id: number,
  name: string,
  folder_id: number | null
): ConversationTagDetail => ({
  id,
  folder_id,
  name,
  color: "#0969da",
  sort_order: id,
})

const folder = (
  id: number,
  name: string,
  parentId: number | null = null
): FolderDetail =>
  ({
    id,
    name,
    path: `/p/${name}`,
    alias: null,
    parent_id: parentId,
    kind: "regular",
  }) as unknown as FolderDetail

function renderHost() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      <ConversationTagsManagerHost />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  resetAppWorkspaceStore()
  resetConversationTagsStore()
  resetConversationTagsManagerForTests()
  // "alpha" sorts first, and is where a manager with nowhere better to go
  // lands; "beta-wt" is beta's worktree.
  const all = [folder(1, "alpha"), folder(2, "beta"), folder(3, "beta-wt", 2)]
  useAppWorkspaceStore.setState({
    folders: all,
    allFolders: all,
    foldersHydrated: true,
    activeFolderId: null,
  })
  h.tags = [
    tag(1, "bug", null),
    tag(2, "beta-only", 2),
    tag(3, "alpha-only", 1),
  ]
  h.branchTag = { enabled: false, color: "#6e7781" }
  h.updateBranchTag.mockClear()
  h.requestCuration.mockReset().mockResolvedValue(null)
})

describe("ConversationTagsManager", () => {
  it("previews without writes and applies only the explicitly selected edited item", async () => {
    const user = userEvent.setup()
    h.requestCuration.mockImplementation(
      async (request: { action: string }) => {
        if (request.action === "history") return []
        if (request.action !== "start") return null
        return {
          id: "test-preview",
          state: "review",
          total: 3,
          scanned: 3,
          createdAt: 1,
          notices: [],
          error: null,
          items: h.tags.slice(0, 2).map((before) => ({
            change: {
              kind: "update",
              tagId: before.id,
              name: `${before.name}-suggested`,
            },
            before: { ...before, is_protected: false },
            target: null,
            affected: [],
          })),
        }
      }
    )
    renderHost()
    act(() => openConversationTagsManager())
    await user.click(
      await screen.findByRole("button", { name: "AI tag curation" })
    )
    await user.click(
      await screen.findByRole("button", { name: "Scan all conversations" })
    )
    const apply = await screen.findByRole("button", {
      name: "Apply selected (0)",
    })
    expect(apply).toBeDisabled()
    expect(
      h.requestCuration.mock.calls.some(
        ([request]) => request.action === "apply"
      )
    ).toBe(false)

    await user.click(screen.getByRole("checkbox", { name: "Update tag: bug" }))
    const name = screen.getByRole("textbox", { name: "Tag name" })
    await user.clear(name)
    await user.type(name, "browser bug")
    await user.click(screen.getByRole("button", { name: "Apply selected (1)" }))
    expect(h.requestCuration).toHaveBeenCalledWith({
      action: "apply",
      id: "test-preview",
      choices: [{ index: 0, name: "browser bug" }],
    })
  })

  it("requires separate confirmations to delete a tag with manual links", async () => {
    const user = userEvent.setup()
    const preview: CurationJob = {
      id: "delete-preview",
      state: "review",
      total: 1,
      scanned: 1,
      createdAt: 1,
      notices: [],
      error: null,
      items: [
        {
          change: { kind: "delete", tagId: 1 },
          before: { ...h.tags[0], is_protected: false },
          target: null,
          affected: [{ id: 5, title: "Browser layout", manual: true }],
        },
      ],
    }
    h.requestCuration.mockImplementation(async (request: CurationRequest) => {
      if (request.action === "status") return preview
      if (request.action === "history") return []
      return null
    })
    renderHost()
    act(() => openConversationTagsManager())
    await user.click(
      await screen.findByRole("button", { name: "AI tag curation" })
    )
    await user.click(
      await screen.findByRole("checkbox", { name: "Delete tag: bug" })
    )

    const apply = screen.getByRole("button", { name: "Apply selected (1)" })
    expect(apply).toBeDisabled()
    await user.click(
      screen.getByRole("checkbox", {
        name: "Confirm deleting this tag and its links",
      })
    )
    expect(apply).toBeDisabled()
    await user.click(
      screen.getByRole("checkbox", {
        name: "Confirm removing the listed manual links",
      })
    )
    await user.click(apply)
    expect(h.requestCuration).toHaveBeenCalledWith({
      action: "apply",
      id: "delete-preview",
      choices: [{ index: 0, confirmManual: true, confirmDelete: true }],
    })
  })

  it("keeps history until the user confirms undo or record removal", async () => {
    const user = userEvent.setup()
    let history: CurationJob[] = Array.from({ length: 20 }, (_, index) => ({
      id: `batch-${index}`,
      state: index === 0 ? "applied" : "undone",
      total: 1,
      scanned: 1,
      createdAt: 1,
      notices: [],
      error: null,
      items: [],
    }))
    h.requestCuration.mockImplementation(async (request: CurationRequest) => {
      if (request.action === "history") return history
      if (request.action === "undo")
        history = history.map((batch) =>
          batch.id === request.id ? { ...batch, state: "undone" } : batch
        )
      if (request.action === "purge")
        history = history.filter((batch) => batch.id !== request.id)
      return null
    })
    renderHost()
    act(() => openConversationTagsManager())
    await user.click(
      await screen.findByRole("button", { name: "AI tag curation" })
    )
    expect(await screen.findByText(/You have 20 batches/)).toBeVisible()

    const undo = screen.getByRole("button", { name: "Undo batch" })
    await user.click(undo)
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(h.requestCuration).not.toHaveBeenCalledWith({
      action: "undo",
      id: "batch-0",
    })
    await user.click(undo)
    await user.click(screen.getByRole("button", { name: "Confirm" }))
    expect(h.requestCuration).toHaveBeenCalledWith({
      action: "undo",
      id: "batch-0",
    })
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Undo batch" })).toBeNull()
    )

    await user.click(
      screen.getAllByRole("button", { name: "Remove record" })[0]
    )
    expect(
      screen.getByText(/permanently removes the option to undo/)
    ).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Confirm" }))
    expect(h.requestCuration).toHaveBeenCalledWith({
      action: "purge",
      id: "batch-0",
    })
    await waitFor(() =>
      expect(screen.queryByText(/You have 20 batches/)).toBeNull()
    )
  })

  it("opens on the folder it was opened about — a worktree on its repo", async () => {
    renderHost()
    expect(screen.queryByRole("dialog")).toBeNull()
    act(() => openConversationTagsManager({ folderId: 3 }))

    expect(
      await screen.findByRole("dialog", { name: "Manage tags" })
    ).toBeTruthy()
    // Loaded on opening: nothing had fetched the tag list yet.
    expect(await screen.findByText("beta-only")).toBeTruthy()
    expect(screen.getByText("bug")).toBeTruthy()
    expect(screen.queryByText("alpha-only")).toBeNull()
  })

  it("opens on the folder of the conversation on screen when told none", async () => {
    useAppWorkspaceStore.setState({ activeFolderId: 2 })
    renderHost()
    act(() => openConversationTagsManager())

    expect(await screen.findByText("beta-only")).toBeTruthy()
    expect(screen.queryByText("alpha-only")).toBeNull()
  })

  it("otherwise lands on the first folder with tags and stays there when another gets one", async () => {
    h.tags = [tag(1, "bug", null), tag(2, "beta-only", 2)]
    renderHost()
    act(() => openConversationTagsManager())
    expect(await screen.findByText("beta-only")).toBeTruthy()

    // Another window gives "alpha" — earlier in the list — its first tag.
    act(() => {
      useConversationTagsStore
        .getState()
        .applyChange({ kind: "upsert", tag: tag(3, "alpha-first", 1) })
    })
    // Still on beta: the editor was not switched (or remounted) underneath.
    expect(screen.getByText("beta-only")).toBeTruthy()
    expect(screen.queryByText("alpha-first")).toBeNull()
  })

  it("keeps the open dialog's folder, and starts over once closed", async () => {
    const user = userEvent.setup()
    renderHost()
    act(() => openConversationTagsManager({ folderId: 2 }))
    expect(await screen.findByText("beta-only")).toBeTruthy()

    // A second request while one is showing changes nothing.
    act(() => openConversationTagsManager({ folderId: 1 }))
    expect(screen.getByText("beta-only")).toBeTruthy()
    expect(screen.queryByText("alpha-only")).toBeNull()

    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    act(() => openConversationTagsManager({ folderId: 1 }))
    expect(await screen.findByText("alpha-only")).toBeTruthy()
    expect(screen.queryByText("beta-only")).toBeNull()
  })

  it("turns the branch tag on from its checkbox, which unlocks its colour", async () => {
    const user = userEvent.setup()
    renderHost()
    act(() => openConversationTagsManager())
    const show = await screen.findByRole("checkbox", { name: "Show" })
    // Usable once the setting is known.
    await waitFor(() => expect(show.hasAttribute("disabled")).toBe(false))
    const swatch = () => screen.getByRole("radio", { name: "#1a7f37" })
    expect(swatch().hasAttribute("disabled")).toBe(true)

    await user.click(show)
    expect(h.updateBranchTag).toHaveBeenCalledWith({
      enabled: true,
      color: "#6e7781",
    })
    expect(swatch().hasAttribute("disabled")).toBe(false)
    expect(
      screen.getByTitle("Branch: main").style.getPropertyValue("--fl-bg")
    ).toBe("#6e7781")

    await user.click(show)
    expect(h.updateBranchTag).toHaveBeenLastCalledWith({
      enabled: false,
      color: "#6e7781",
    })
    expect(swatch().hasAttribute("disabled")).toBe(true)
  })

  it("saves a colour once it stays picked, and one still waiting on close", async () => {
    h.branchTag = { enabled: true, color: "#6e7781" }
    renderHost()
    act(() => openConversationTagsManager())
    // Loaded and usable before the clock is frozen: the async finders poll on
    // real timers.
    const red = await screen.findByRole("radio", { name: "#cf222e" })
    await waitFor(() => expect(red.hasAttribute("disabled")).toBe(false))
    const preview = () =>
      screen.getByTitle("Branch: main").style.getPropertyValue("--fl-bg")

    // Plain DOM events from here on: user-event's own pacing waits on the
    // frozen clock.
    vi.useFakeTimers()
    try {
      fireEvent.click(red)
      act(() => vi.advanceTimersByTime(200))
      fireEvent.click(screen.getByRole("radio", { name: "#1a7f37" }))
      act(() => vi.advanceTimersByTime(200))
      // Drawn at once; 400ms after the first pick but 200ms after the last,
      // nothing is saved yet — the pause runs from the LAST pick.
      expect(preview()).toBe("#1a7f37")
      expect(h.updateBranchTag).not.toHaveBeenCalled()
      await act(async () => vi.advanceTimersByTime(100))
      expect(h.updateBranchTag).toHaveBeenCalledTimes(1)
      expect(h.updateBranchTag).toHaveBeenLastCalledWith({
        enabled: true,
        color: "#1a7f37",
      })
      await act(async () => vi.advanceTimersByTime(2000))
      expect(h.updateBranchTag).toHaveBeenCalledTimes(1)

      // Picked, then closed before the pause is up: saved on the way out,
      // and only then.
      fireEvent.click(screen.getByRole("radio", { name: "#0969da" }))
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "Escape",
      })
      expect(screen.queryByRole("dialog")).toBeNull()
      expect(h.updateBranchTag).toHaveBeenCalledTimes(2)
      expect(h.updateBranchTag).toHaveBeenLastCalledWith({
        enabled: true,
        color: "#0969da",
      })
      await act(async () => vi.advanceTimersByTime(2000))
      expect(h.updateBranchTag).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { PromptStashEntry } from "@/lib/types"

const listStash = vi.fn<() => Promise<PromptStashEntry[]>>()
const removeStash = vi.fn<(id: number) => Promise<void>>()
const restoreStash = vi.fn()

vi.mock("@/lib/api", () => ({
  listPromptStash: (...args: []) => listStash(...args),
  removePromptStash: (id: number) => removeStash(id),
  restorePromptStash: () => restoreStash(),
}))
vi.mock("@/lib/browser/native-surface-occlusion", () => ({
  acquireNativeSurfaceOcclusionFor: () => () => {},
}))

import { PromptStashSettings } from "./prompt-stash-settings"

function entry(
  id: number,
  overrides: Partial<PromptStashEntry> = {}
): PromptStashEntry {
  return {
    id,
    preview: `Saved input ${id}`,
    updatedAt: "2026-11-02T12:30:00Z",
    attachmentCount: 2,
    scopeKey: `conv:${id}`,
    conversationId: id,
    conversationTitle: `Conversation ${id}`,
    conversationStatus: "in_progress",
    conversationDeleted: false,
    folderName: "Project Atlas",
    assetBytes: 2048,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function renderSettings() {
  return render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={enMessages}>
      <PromptStashSettings />
    </NextIntlClientProvider>
  )
}

async function chooseFilter(name: string) {
  const user = userEvent.setup()
  await user.click(screen.getByRole("combobox", { name: "Filter favorites" }))
  await user.click(await screen.findByRole("option", { name, exact: true }))
}

beforeEach(() => {
  listStash.mockReset().mockResolvedValue([entry(1)])
  removeStash.mockReset().mockResolvedValue(undefined)
  restoreStash.mockClear()
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-04T12:00:00Z"))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("PromptStashSettings", () => {
  it("loads management metadata without a scope or restoring attachments", async () => {
    listStash.mockResolvedValue([
      entry(1, { conversationDeleted: true, preview: "Input with attachments" }),
    ])
    renderSettings()

    const row = (await screen.findByText("Input with attachments")).closest("tr")!
    expect(within(row).getByText("Conversation 1")).toBeInTheDocument()
    expect(within(row).getByText("Project Atlas")).toBeInTheDocument()
    expect(within(row).getByText("Conversation deleted")).toBeInTheDocument()
    expect(within(row).getByText("2")).toHaveAttribute(
      "title",
      "Attachment storage: 2048 bytes"
    )
    expect(row.querySelector("time")).toHaveAttribute(
      "dateTime",
      "2026-11-02T12:30:00Z"
    )
    expect(listStash).toHaveBeenCalledWith()
    expect(removeStash).not.toHaveBeenCalled()
    expect(restoreStash).not.toHaveBeenCalled()
  })

  it("searches preview, conversation and project metadata", async () => {
    const user = userEvent.setup()
    listStash.mockResolvedValue([
      entry(1, { preview: "Fix parser", conversationTitle: "Planning" }),
      entry(2, { preview: "Write tests", folderName: "Project Borealis" }),
    ])
    renderSettings()
    await screen.findByText("Fix parser")
    const search = screen.getByRole("textbox", {
      name: "Search preview, conversation or project",
    })

    for (const query of ["parser", "PLANNING", "Atlas"]) {
      await user.clear(search)
      await user.type(search, query)
      expect(screen.getByText("Fix parser")).toBeInTheDocument()
      expect(screen.queryByText("Write tests")).not.toBeInTheDocument()
    }
    await user.clear(search)
    await user.type(search, "missing")
    expect(screen.getByText("No favorites match the current search and filter.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Clear filters" }))
    expect(screen.getByText("Write tests")).toBeInTheDocument()
  })

  it("filters completed including cancelled, old entries, legacy and draft scopes", async () => {
    listStash.mockResolvedValue([
      entry(1),
      entry(2, { conversationStatus: "completed" }),
      entry(3, { conversationStatus: "cancelled" }),
      entry(4, { updatedAt: "2026-09-01T00:00:00Z" }),
      entry(5, {
        scopeKey: null,
        conversationId: null,
        conversationTitle: null,
        conversationStatus: null,
        folderName: null,
      }),
      entry(6, {
        scopeKey: "draft:project-9",
        conversationId: null,
        conversationTitle: null,
        conversationStatus: null,
      }),
      entry(7, { updatedAt: "invalid-time" }),
    ])
    renderSettings()
    await screen.findByText("Saved input 7")

    for (const [filter, ids] of [
      ["Completed / cancelled", [2, 3]],
      ["Unused for 30 days", [4]],
      ["Legacy, unassigned", [5]],
      ["New conversation drafts", [6]],
      ["All", [1, 2, 3, 4, 5, 6, 7]],
    ] as const) {
      await chooseFilter(filter)
      for (let id = 1; id <= 7; id += 1) {
        expect(Boolean(screen.queryByText(`Saved input ${id}`))).toBe(
          (ids as readonly number[]).includes(id)
        )
      }
    }
    // 浏览和切换筛选不能自动清理旧数据，也不能恢复附件。
    expect(removeStash).not.toHaveBeenCalled()
    expect(restoreStash).not.toHaveBeenCalled()
  })

  it("requires confirmation for a single delete and cancellation does nothing", async () => {
    const user = userEvent.setup()
    renderSettings()
    await screen.findByText("Saved input 1")
    await user.click(screen.getByRole("button", { name: "Delete favorite: Saved input 1" }))
    expect(screen.getByRole("alertdialog")).toBeInTheDocument()
    expect(removeStash).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Cancel", exact: true }))
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    expect(removeStash).not.toHaveBeenCalled()

    listStash.mockResolvedValue([])
    await user.click(screen.getByRole("button", { name: "Delete favorite: Saved input 1" }))
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete favorites", exact: true }))
    await waitFor(() => expect(removeStash).toHaveBeenCalledWith(1))
    expect(removeStash.mock.calls).toEqual([[1]])
    expect(await screen.findByText("No saved favorites. Save input from a conversation to see it here.")).toBeInTheDocument()
  })

  it("selects only the current filtered rows and keeps newly refreshed data after deleting the confirmed IDs", async () => {
    const user = userEvent.setup()
    const deletion = deferred<void>()
    listStash.mockResolvedValueOnce([
      entry(1),
      entry(2, { conversationStatus: "completed" }),
      entry(3, { conversationStatus: "cancelled" }),
    ]).mockResolvedValue([
      entry(1),
      entry(4, { preview: "A newly saved favorite", conversationStatus: "completed" }),
    ])
    removeStash.mockImplementation(() => deletion.promise)
    renderSettings()
    await screen.findByText("Saved input 1")
    await chooseFilter("Completed / cancelled")
    await user.click(screen.getByRole("checkbox", { name: "Select all filtered favorites" }))
    expect(screen.getByText(/2 selected/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Delete selected", exact: true }))
    expect(removeStash).not.toHaveBeenCalled()
    const confirm = within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete favorites", exact: true })
    await user.dblClick(confirm)
    expect(removeStash.mock.calls).toEqual([[2], [3]])
    await act(async () => deletion.resolve(undefined))

    expect(await screen.findByText("A newly saved favorite")).toBeInTheDocument()
    expect(screen.queryByText("Saved input 2")).not.toBeInTheDocument()
    expect(screen.queryByText("Saved input 3")).not.toBeInTheDocument()
    expect(removeStash.mock.calls).toEqual([[2], [3]])
    expect(listStash).toHaveBeenCalledTimes(2)
    await chooseFilter("All")
    expect(screen.getByText("Saved input 1")).toBeInTheDocument()
  })

  it("removes only successful batch items, retaining failed rows and their selection for retry", async () => {
    const user = userEvent.setup()
    listStash.mockResolvedValue([entry(1), entry(2), entry(3)])
    removeStash.mockImplementation(async (id) => {
      if (id === 2) throw new Error("permission denied")
    })
    renderSettings()
    await screen.findByText("Saved input 3")
    await user.click(screen.getByRole("checkbox", { name: "Select all filtered favorites" }))
    await user.click(screen.getByRole("button", { name: "Delete selected", exact: true }))
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete favorites", exact: true }))

    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied")
    expect(screen.queryByText("Saved input 1")).not.toBeInTheDocument()
    expect(screen.queryByText("Saved input 3")).not.toBeInTheDocument()
    expect(screen.getByText("Saved input 2")).toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: "Select favorite: Saved input 2" })).toBeChecked()
    expect(screen.getByText(/1 selected/)).toBeInTheDocument()
    expect(listStash).toHaveBeenCalledTimes(1)

    removeStash.mockResolvedValue(undefined)
    listStash.mockResolvedValue([])
    await user.click(screen.getByRole("button", { name: "Delete selected", exact: true }))
    expect(removeStash).toHaveBeenCalledTimes(3)
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete favorites", exact: true }))
    await waitFor(() => expect(removeStash).toHaveBeenCalledTimes(4))
    expect(removeStash.mock.calls[3]).toEqual([2])
    await waitFor(() => expect(screen.queryByText("Saved input 2")).not.toBeInTheDocument())
  })

  it("shows loading, a recoverable load error and the empty state", async () => {
    const user = userEvent.setup()
    const request = deferred<PromptStashEntry[]>()
    listStash.mockReturnValueOnce(request.promise).mockResolvedValue([])
    renderSettings()
    expect(screen.getByRole("status")).toHaveTextContent("Loading favorites")
    await act(async () => request.reject(new Error("offline")))
    expect(await screen.findByRole("alert")).toHaveTextContent("offline")
    await user.click(screen.getByRole("button", { name: "Retry", exact: true }))
    expect(await screen.findByText("No saved favorites. Save input from a conversation to see it here.")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("does not let an old page request replace a new page after unmount", async () => {
    const oldRequest = deferred<PromptStashEntry[]>()
    listStash.mockReturnValueOnce(oldRequest.promise).mockResolvedValue([entry(2)])
    const oldPage = renderSettings()
    oldPage.unmount()
    renderSettings()
    await screen.findByText("Saved input 2")
    await act(async () => oldRequest.resolve([entry(1)]))
    expect(screen.getByText("Saved input 2")).toBeInTheDocument()
    expect(screen.queryByText("Saved input 1")).not.toBeInTheDocument()
  })

  it("does not refresh or report a pending delete into another page after unmount", async () => {
    const user = userEvent.setup()
    const deletion = deferred<void>()
    removeStash.mockReturnValue(deletion.promise)
    const oldPage = renderSettings()
    await screen.findByText("Saved input 1")
    await user.click(screen.getByRole("button", { name: "Delete favorite: Saved input 1" }))
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete favorites", exact: true }))
    oldPage.unmount()
    listStash.mockResolvedValue([entry(2)])
    renderSettings()
    await screen.findByText("Saved input 2")
    await act(async () => deletion.reject(new Error("old delete failed")))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByText("Saved input 2")).toBeInTheDocument()
    expect(listStash).toHaveBeenCalledTimes(2)
  })
})

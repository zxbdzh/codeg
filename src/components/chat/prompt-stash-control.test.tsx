import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { PromptStashEntry } from "@/lib/types"

const api = vi.hoisted(() => ({
  listPromptStash: vi.fn(),
  removePromptStash: vi.fn(),
  restorePromptStash: vi.fn(),
  savePromptStash: vi.fn(),
}))
vi.mock("@/lib/api", () => api)
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import { PromptStashControl } from "./prompt-stash-control"

function entry(id: number, preview: string): PromptStashEntry {
  return {
    id,
    preview,
    updatedAt: "2026-10-31T11:48:02.000Z",
    attachmentCount: 0,
  }
}

const SNAPSHOT = {
  text: "restored",
  doc: { type: "doc", content: [] },
  attachments: [],
  embeddedPayloads: {},
} as never

function renderControl() {
  const restoreIfEmpty = vi.fn(() => true)
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PromptStashControl
        capture={() => null}
        clearIfUnchanged={() => {}}
        restoreIfEmpty={restoreIfEmpty}
        anchor={{ current: null }}
        shortcut=""
        pending={false}
      />
    </NextIntlClientProvider>
  )
  return { restoreIfEmpty }
}

async function openList() {
  const user = userEvent.setup({ pointerEventsCheck: 0 })
  await user.click(
    screen.getByRole("button", { name: "Collect or restore prompt" })
  )
  await screen.findByText("first")
  return user
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.listPromptStash.mockResolvedValue([entry(1, "first"), entry(2, "second")])
  api.restorePromptStash.mockResolvedValue(SNAPSHOT)
  api.removePromptStash.mockResolvedValue(undefined)
})

describe("PromptStashControl", () => {
  it("consumes an entry once it has been restored", async () => {
    const { restoreIfEmpty } = renderControl()
    const user = await openList()

    await user.click(screen.getByText("first"))

    await waitFor(() => expect(restoreIfEmpty).toHaveBeenCalled())
    // 取用即消费：后端记录随之删除，列表不再保留这一条。
    await waitFor(() => expect(api.removePromptStash).toHaveBeenCalledWith(1))
  })

  it("keeps the entry when the input already had content", async () => {
    const { restoreIfEmpty } = renderControl()
    restoreIfEmpty.mockReturnValue(false)
    const user = await openList()

    await user.click(screen.getByText("first"))

    await waitFor(() => expect(restoreIfEmpty).toHaveBeenCalled())
    expect(api.removePromptStash).not.toHaveBeenCalled()
    expect(screen.getByText("first")).toBeTruthy()
  })

  it("asks before deleting and only then removes it", async () => {
    renderControl()
    const user = await openList()

    await user.click(screen.getAllByRole("button", { name: "Delete" })[0])
    const dialog = await screen.findByRole("alertdialog")
    // 确认之前不动数据，条目也还在。
    expect(api.removePromptStash).not.toHaveBeenCalled()
    expect(dialog.textContent).toContain("first")

    await user.click(within(dialog).getByRole("button", { name: "Delete" }))

    await waitFor(() => expect(api.removePromptStash).toHaveBeenCalledWith(1))
    await waitFor(() => expect(screen.queryByText("first")).toBeNull())
    expect(api.restorePromptStash).not.toHaveBeenCalled()
  })
})

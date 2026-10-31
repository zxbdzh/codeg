import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, expect, it, vi } from "vitest"
import messages from "@/i18n/messages/en.json"

const h = vi.hoisted(() => ({
  suggest: vi.fn(),
  apply: vi.fn(),
  tags: [
    { id: 7, name: "Bug", color: "#0969da", folder_id: null, sort_order: 0 },
  ],
  upsert: vi.fn(),
}))
vi.mock("@/lib/api", () => ({
  suggestConversationTags: h.suggest,
  applySuggestedTags: h.apply,
  listConversationTags: async () => h.tags,
}))
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ allFolders: [] }),
    {
      getState: () => ({ applyConversationUpsert: h.upsert }),
    }
  ),
}))
vi.mock("@/stores/conversation-tags-store", () => ({
  useConversationTagsStore: { getState: () => ({ fetchTags: vi.fn() }) },
}))
import { AiTagSuggestionDialog } from "./ai-tag-suggestion-dialog"

beforeEach(() => {
  vi.clearAllMocks()
  h.suggest.mockResolvedValue({
    tags: [{ name: "Bug", reason: "A regression was fixed" }],
    new_tags: [{ name: "Caching", color: "#123456" }],
  })
  h.apply.mockResolvedValue({ id: 12, tag_ids: [7] })
})
function show() {
  const close = vi.fn()
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AiTagSuggestionDialog conversationId={12} folderId={3} onClose={close} />
    </NextIntlClientProvider>
  )
  return close
}
it("shows reasons without writing, selects existing tags but never silently creates proposed ones", async () => {
  const user = userEvent.setup()
  show()
  await screen.findByText("A regression was fixed")
  expect(h.apply).not.toHaveBeenCalled()
  expect(screen.getByRole("checkbox", { name: "Bug" })).toBeChecked()
  expect(screen.getByRole("checkbox", { name: "Caching" })).not.toBeChecked()
  await user.click(screen.getByRole("button", { name: "Apply selected tags" }))
  await waitFor(() =>
    expect(h.apply).toHaveBeenCalledWith({
      conversationId: 12,
      existingTagIds: [7],
      newTags: [],
    })
  )
  expect(h.upsert).toHaveBeenCalledWith({ id: 12, tag_ids: [7] })
})
it("cancel leaves every tag untouched", async () => {
  const user = userEvent.setup()
  const close = show()
  await screen.findByText("A regression was fixed")
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  expect(close).toHaveBeenCalled()
  expect(h.apply).not.toHaveBeenCalled()
})
it("asks again with the cache bypassed when the user wants other suggestions", async () => {
  const user = userEvent.setup()
  show()
  await screen.findByText("A regression was fixed")
  // 首次进入走缓存路径。
  expect(h.suggest).toHaveBeenCalledWith(12, false)
  h.suggest.mockResolvedValueOnce({
    tags: [{ name: "Bug", reason: "Another angle: flaky test" }],
    new_tags: [],
  })

  await user.click(screen.getByRole("button", { name: "Suggest again" }))

  await screen.findByText("Another angle: flaky test")
  expect(h.suggest).toHaveBeenLastCalledWith(12, true)
  // 换一批仍然只是建议，确认前不写任何标签。
  expect(h.apply).not.toHaveBeenCalled()
})

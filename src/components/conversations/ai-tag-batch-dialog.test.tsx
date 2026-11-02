import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import messages from "@/i18n/messages/en.json"

const harness = vi.hoisted(() => ({
  status: vi.fn(),
  generate: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  confirm: vi.fn(),
  skip: vi.fn(),
  ignore: vi.fn(),
  restore: vi.fn(),
}))
vi.mock("@/lib/api", () => ({
  getTagSuggestionStatus: harness.status,
  generateTagSuggestionBatch: harness.generate,
  openTagSuggestionBatch: harness.open,
  closeTagSuggestionBatch: harness.close,
  confirmTagSuggestionBatch: harness.confirm,
  skipTagSuggestionBatch: harness.skip,
  ignoreTagSuggestion: harness.ignore,
  restoreIgnoredTag: harness.restore,
  listConversationTags: async () => [
    { id: 7, name: "MCP", color: "#0969da", folder_id: null },
  ],
}))
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ allFolders: [] }),
    {
      getState: () => ({ applyConversationUpsert: vi.fn() }),
    }
  ),
}))
vi.mock("@/stores/conversation-tags-store", () => ({
  useConversationTagsStore: { getState: () => ({ fetchTags: vi.fn() }) },
}))
import { AiTagBatchDialog } from "./ai-tag-batch-dialog"

beforeEach(() => {
  vi.clearAllMocks()
  const batch = {
    id: "batch-A",
    conversationId: 12,
    input: "one",
    config: "v1",
    createdAt: 1000,
    candidates: [
      {
        index: 0,
        name: "MCP",
        reason: "Protocol integration",
        color: "#0969da",
        folderId: null,
        tagIds: [7],
      },
    ],
  }
  harness.status.mockResolvedValue({
    batch,
    ignored: [],
    running: false,
    error: null,
  })
  harness.open.mockResolvedValue(batch)
  harness.close.mockResolvedValue(undefined)
  harness.skip.mockResolvedValue(undefined)
  harness.ignore.mockResolvedValue(undefined)
  harness.restore.mockResolvedValue(undefined)
  harness.confirm.mockResolvedValue({ id: 12, tag_ids: [7] })
})

afterEach(() => vi.useRealTimers())

function show() {
  const onClose = vi.fn()
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AiTagBatchDialog conversationId={12} folderId={3} onClose={onClose} />
    </NextIntlClientProvider>
  )
  return onClose
}

it("confirms the displayed batch without generating again", async () => {
  const user = userEvent.setup()
  const close = show()
  await screen.findByText("Protocol integration")
  expect(harness.generate).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "Apply selected tags" }))
  await waitFor(() =>
    expect(harness.confirm).toHaveBeenCalledWith({
      conversationId: 12,
      batchId: "batch-A",
      choices: [{ index: 0, tagId: 7 }],
    })
  )
  expect(close).toHaveBeenCalled()
})

it("skips only the displayed batch without ignoring any tag", async () => {
  const user = userEvent.setup()
  const close = show()
  await screen.findByText("Protocol integration")
  await user.click(screen.getByRole("button", { name: "Skip this batch" }))
  await waitFor(() => expect(harness.skip).toHaveBeenCalledWith(12, "batch-A"))
  expect(harness.ignore).not.toHaveBeenCalled()
  expect(harness.confirm).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalled()
})

it("explicitly ignores one candidate without applying the batch", async () => {
  const user = userEvent.setup()
  show()
  await screen.findByText("Protocol integration")
  await user.click(screen.getByRole("button", { name: "Ignore MCP" }))
  await waitFor(() =>
    expect(harness.ignore).toHaveBeenCalledWith(12, "batch-A", 0, 7)
  )
  expect(harness.confirm).not.toHaveBeenCalled()
  expect(screen.queryByText("Protocol integration")).not.toBeInTheDocument()
})

it("restores one ignored tag without assigning or generating", async () => {
  const user = userEvent.setup()
  harness.status.mockResolvedValue({
    batch: null,
    running: false,
    error: null,
    ignored: [{ key: "tag:7", tagId: 7, name: "MCP", folderId: null }],
  })
  show()
  await user.click(await screen.findByRole("button", { name: "Restore MCP" }))
  await waitFor(() => expect(harness.restore).toHaveBeenCalledWith(12, "tag:7"))
  expect(harness.generate).not.toHaveBeenCalled()
  expect(harness.confirm).not.toHaveBeenCalled()
})

it("requires choosing the scope for an ambiguous existing tag", async () => {
  const user = userEvent.setup()
  const batch = {
    id: "ambiguous",
    conversationId: 12,
    input: "one",
    config: "v1",
    createdAt: 1000,
    candidates: [
      {
        name: "MCP",
        reason: "Choose scope",
        color: "#0969da",
        folderId: null,
        tagIds: [7, 9],
      },
    ],
  }
  harness.status.mockResolvedValue({
    batch,
    ignored: [],
    running: false,
    error: null,
  })
  harness.open.mockResolvedValue(batch)
  show()
  await screen.findByRole("combobox", { name: "Scope for MCP" })
  expect(screen.getByRole("checkbox", { name: "MCP" })).not.toBeChecked()
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Scope for MCP" }),
    "7"
  )
  await user.click(screen.getByRole("checkbox", { name: "MCP" }))
  await user.click(screen.getByRole("button", { name: "Apply selected tags" }))
  await waitFor(() =>
    expect(harness.confirm).toHaveBeenCalledWith({
      conversationId: 12,
      batchId: "ambiguous",
      choices: [{ index: 0, tagId: 7 }],
    })
  )
})

it("only forces generation when the user requests another batch", async () => {
  const user = userEvent.setup()
  const batch = {
    id: "batch-B",
    conversationId: 12,
    input: "two",
    config: "v1",
    createdAt: 2000,
    candidates: [
      {
        name: "MCP",
        reason: "Refreshed reason",
        color: "#0969da",
        folderId: null,
        tagIds: [7],
      },
    ],
  }
  show()
  await screen.findByText("Protocol integration")
  harness.generate.mockResolvedValue({
    batch,
    ignored: [],
    running: false,
    error: null,
  })
  harness.open.mockResolvedValue(batch)
  await user.click(screen.getByRole("button", { name: "Suggest again" }))
  expect(harness.generate).toHaveBeenCalledWith(12, true)
  await screen.findByText("Refreshed reason")
  expect(harness.confirm).not.toHaveBeenCalled()
})

it("requires explicitly selecting a proposed tag and applies its edited name", async () => {
  const user = userEvent.setup()
  const batch = {
    id: "new-tag",
    conversationId: 12,
    input: "one",
    config: "v1",
    createdAt: 1000,
    candidates: [
      {
        name: "Avatar",
        reason: "New topic",
        color: "#123456",
        folderId: null,
        tagIds: [],
      },
    ],
  }
  harness.status.mockResolvedValue({
    batch,
    ignored: [],
    running: false,
    error: null,
  })
  harness.open.mockResolvedValue(batch)
  show()
  const checkbox = await screen.findByRole("checkbox", { name: "Avatar" })
  expect(checkbox).not.toBeChecked()
  await user.clear(screen.getByRole("textbox", { name: "Tag name" }))
  await user.type(
    screen.getByRole("textbox", { name: "Tag name" }),
    "Digital avatar"
  )
  await user.click(checkbox)
  await user.click(screen.getByRole("button", { name: "Apply selected tags" }))
  await waitFor(() =>
    expect(harness.confirm).toHaveBeenCalledWith({
      conversationId: 12,
      batchId: "new-tag",
      choices: [
        { index: 0, name: "Digital avatar", color: "#123456", folderId: null },
      ],
    })
  )
})

it("requests an initial batch only after the user opens an empty suggestion dialog", async () => {
  const batch = {
    id: "first",
    conversationId: 12,
    input: "one",
    config: "v1",
    createdAt: 1000,
    candidates: [
      {
        name: "MCP",
        reason: "First suggestions",
        color: "#0969da",
        folderId: null,
        tagIds: [7],
      },
    ],
  }
  harness.status.mockResolvedValue({
    batch: null,
    ignored: [],
    running: false,
    error: null,
  })
  harness.generate.mockResolvedValue({
    batch,
    ignored: [],
    running: false,
    error: null,
  })
  harness.open.mockResolvedValue(batch)
  show()
  await screen.findByText("First suggestions")
  expect(harness.generate).toHaveBeenCalledWith(12, false)
})

it("preserves candidate identity when older entries were filtered out", async () => {
  const user = userEvent.setup()
  const batch = {
    id: "filtered",
    conversationId: 12,
    input: "one",
    config: "v1",
    createdAt: 1000,
    candidates: [
      {
        index: 2,
        name: "MCP",
        reason: "Still relevant",
        color: "#0969da",
        folderId: null,
        tagIds: [7],
      },
    ],
  }
  harness.status.mockResolvedValue({
    batch,
    ignored: [],
    running: false,
    error: null,
  })
  harness.open.mockResolvedValue(batch)
  show()
  await screen.findByText("Still relevant")
  await user.click(screen.getByRole("button", { name: "Apply selected tags" }))
  await waitFor(() =>
    expect(harness.confirm).toHaveBeenCalledWith({
      conversationId: 12,
      batchId: "filtered",
      choices: [{ index: 2, tagId: 7 }],
    })
  )
})

it("releases a batch that finishes opening after the dialog unmounts", async () => {
  const batch = {
    id: "late",
    conversationId: 12,
    input: "one",
    config: "v1",
    createdAt: 1000,
    candidates: [],
  }
  let finishOpen: (value: typeof batch) => void = () => {}
  harness.open.mockReturnValue(
    new Promise<typeof batch>((resolve) => {
      finishOpen = resolve
    })
  )
  const view = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AiTagBatchDialog conversationId={12} folderId={3} onClose={vi.fn()} />
    </NextIntlClientProvider>
  )
  await waitFor(() => expect(harness.open).toHaveBeenCalled())
  view.unmount()
  finishOpen(batch)
  await waitFor(() => expect(harness.close).toHaveBeenCalledWith(12, "late"))
})

it("shows a stored generation failure without discarding the previous batch", async () => {
  harness.status.mockResolvedValue({
    batch: { id: "batch-A" },
    ignored: [],
    running: false,
    error: "The model was not found",
  })
  show()
  await screen.findByText("Protocol integration")
  expect(screen.getByRole("alert")).toHaveTextContent("The model was not found")
})

it("releases the refreshed batch when the dialog closes", async () => {
  const user = userEvent.setup()
  const next = {
    id: "refreshed",
    conversationId: 12,
    input: "two",
    config: "v1",
    createdAt: 2000,
    candidates: [],
  }
  const view = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AiTagBatchDialog conversationId={12} folderId={3} onClose={vi.fn()} />
    </NextIntlClientProvider>
  )
  await screen.findByText("Protocol integration")
  harness.generate.mockResolvedValue({
    batch: next,
    ignored: [],
    running: false,
    error: null,
  })
  harness.open.mockResolvedValue(next)
  await user.click(screen.getByRole("button", { name: "Suggest again" }))
  await waitFor(() =>
    expect(harness.open).toHaveBeenCalledWith(12, "refreshed")
  )
  view.unmount()
  await waitFor(() =>
    expect(harness.close).toHaveBeenCalledWith(12, "refreshed")
  )
})

it("releases only its own review lease when closing", async () => {
  harness.open.mockResolvedValue({
    id: "batch-A",
    leaseToken: "window-A",
    conversationId: 12,
    input: "one",
    config: "v1",
    createdAt: 1000,
    candidates: [
      {
        name: "MCP",
        reason: "Owned review",
        color: "#0969da",
        folderId: null,
        tagIds: [7],
      },
    ],
  })
  const view = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AiTagBatchDialog conversationId={12} folderId={3} onClose={vi.fn()} />
    </NextIntlClientProvider>
  )
  await screen.findByText("Owned review")
  view.unmount()
  await waitFor(() =>
    expect(harness.close).toHaveBeenCalledWith(12, "batch-A", "window-A")
  )
})

it("renews its own lease without replacing the displayed snapshot", async () => {
  vi.useFakeTimers()
  const batch = {
    id: "batch-A",
    leaseToken: "window-A",
    conversationId: 12,
    input: "one",
    config: "v1",
    createdAt: 1000,
    candidates: [
      {
        name: "MCP",
        reason: "Owned review",
        color: "#0969da",
        folderId: null,
        tagIds: [7],
      },
    ],
  }
  harness.open.mockResolvedValue(batch)
  await act(async () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AiTagBatchDialog conversationId={12} folderId={3} onClose={vi.fn()} />
      </NextIntlClientProvider>
    )
  })
  expect(screen.getByText("Owned review")).toBeVisible()
  harness.open.mockResolvedValue({
    ...batch,
    candidates: [{ ...batch.candidates[0], reason: "Background replacement" }],
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
  })
  expect(harness.open).toHaveBeenCalledWith(12, "batch-A", "window-A")
  expect(screen.getByText("Owned review")).toBeVisible()
  expect(screen.queryByText("Background replacement")).not.toBeInTheDocument()
  expect(harness.generate).not.toHaveBeenCalled()
})

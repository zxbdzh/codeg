import { StrictMode } from "react"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import arMessages from "@/i18n/messages/ar.json"
import deMessages from "@/i18n/messages/de.json"
import esMessages from "@/i18n/messages/es.json"
import frMessages from "@/i18n/messages/fr.json"
import jaMessages from "@/i18n/messages/ja.json"
import koMessages from "@/i18n/messages/ko.json"
import ptMessages from "@/i18n/messages/pt.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import twMessages from "@/i18n/messages/zh-TW.json"
import type { ResearchBranchInfo } from "@/lib/research-branch"
import type { FileCheckpointResponse } from "@/lib/file-checkpoint"
import { clearResearchSummaryHandoffs } from "@/lib/research-summary-handoff"
import { clearResearchCreationCache } from "@/lib/research-branch-pending"

const api = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  save: vi.fn(),
  generate: vi.fn(),
  cancel: vi.fn(),
  onReconnect: vi.fn(),
  unsubscribe: vi.fn(),
  checkpoint: vi.fn(),
}))

vi.mock("@/lib/research-branch", () => ({
  RESEARCH_BRANCH_MAX_SUMMARY_CHARS: 12_000,
  createResearchBranch: api.create,
  listResearchBranches: api.list,
  saveResearchBranchSummary: api.save,
  generateResearchBranchSummary: api.generate,
  cancelResearchBranchSummary: api.cancel,
}))
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({
    onReconnect: api.onReconnect,
    call: api.checkpoint,
  }),
  getActiveRemoteConnectionId: () => null,
}))

import {
  ResearchBranchPanel,
  type ResearchBranchPanelProps,
} from "./research-branch-panel"

function info(overrides: Partial<ResearchBranchInfo> = {}): ResearchBranchInfo {
  return {
    id: 1,
    sourceConversationId: 10,
    branchConversationId: 20,
    sourceSessionId: "source-session",
    branchSessionId: "branch-session",
    sourceTurnId: null,
    boundary: "session_tail",
    title: "Research branch 1",
    sourceTitle: "Source conversation",
    summary: "Saved finding",
    createdAt: "2026-11-10T00:00:00Z",
    ...overrides,
  }
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const onOpen = vi.fn()
const onReturn = vi.fn()
const onCreated = vi.fn()

function view(overrides: Partial<ResearchBranchPanelProps> = {}) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ResearchBranchPanel
        conversationId={10}
        connectionId="connection-1"
        supportsFork
        connectionReady
        isViewer={false}
        busy={false}
        onOpenConversation={onOpen}
        onReturnSummary={onReturn}
        onCreated={onCreated}
        {...overrides}
      />
    </NextIntlClientProvider>
  )
}

async function expand() {
  await waitFor(() =>
    expect(
      screen.getByRole("region", { name: "Research branch" })
    ).toHaveAttribute("aria-busy", "false")
  )
  await userEvent.click(
    screen.queryByRole("button", { name: "Bring back findings" }) ??
      screen.getByRole("button", { name: "Research branches" })
  )
}

async function openBranches() {
  await userEvent.click(
    screen.getByRole("button", { name: "Research branches" })
  )
}

async function showBranch() {
  api.list.mockResolvedValue([info()])
  const rendered = render(view({ conversationId: 20 }))
  await expand()
  return rendered
}

beforeEach(() => {
  clearResearchSummaryHandoffs()
  clearResearchCreationCache()
  sessionStorage.clear()
  Object.values(api).forEach((mock) => mock.mockReset())
  onOpen.mockReset()
  onReturn.mockReset()
  onCreated.mockReset()
  api.onReconnect.mockReturnValue(api.unsubscribe)
  api.list.mockResolvedValue([])
  api.cancel.mockResolvedValue(undefined)
  api.save.mockImplementation(
    async (branchConversationId: number, summary: string) =>
      info({ branchConversationId, summary })
  )
})

afterEach(cleanup)

describe("ResearchBranchPanel", () => {
  it("includes checkpoints next to the branches menu without requiring native provider fork support", async () => {
    const rendered = render(view({ supportsFork: false, connectionId: null }))
    const checkpoint = screen.getByRole("button", {
      name: enMessages.FileCheckpoint.title,
    })
    expect(checkpoint).toBeEnabled()
    rendered.rerender(view({ busy: true }))
    expect(
      screen.getByRole("button", { name: enMessages.FileCheckpoint.title })
    ).toBeDisabled()
    rendered.rerender(view({ isViewer: true }))
    expect(
      screen.queryByRole("button", { name: enMessages.FileCheckpoint.title })
    ).not.toBeInTheDocument()
    await waitFor(() => expect(api.list).toHaveBeenCalled())
  })

  it("keeps the checkpoint request and global lock when its connection becomes ready", async () => {
    const pending = deferred<FileCheckpointResponse>()
    api.checkpoint.mockReturnValue(pending.promise)
    const rendered = render(
      view({ connectionId: null, connectionReady: false })
    )
    await userEvent.click(
      screen.getByRole("button", { name: enMessages.FileCheckpoint.title })
    )
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true")
    rendered.rerender(view({ connectionId: "connection-ready" }))
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true")
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    })
    window.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(true)
    expect(api.checkpoint).toHaveBeenCalledTimes(1)
    await act(async () => {
      pending.resolve({
        enabled: false,
        root: "F:\\workspace",
        checkpoints: [],
        lastRestoreId: null,
      })
    })
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "false")
    expect(
      screen.getByText(enMessages.FileCheckpoint.disabled)
    ).toBeInTheDocument()
  })

  it("does not render or fetch for drafts and virtual conversation IDs", () => {
    const rendered = render(view({ conversationId: null }))
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    rendered.rerender(view({ conversationId: -1 }))
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(api.list).not.toHaveBeenCalled()
  })

  it("keeps busy guidance with the action instead of a permanent banner", async () => {
    render(view({ busy: true }))
    expect(screen.getByRole("button", { name: "New research" })).toBeDisabled()
    expect(
      screen.getByText(enMessages.ResearchBranch.waitForCompletion)
    ).toHaveClass("sr-only")
    await userEvent.click(screen.getByRole("button", { name: "New research" }))
    expect(api.create).not.toHaveBeenCalled()
  })

  it.each([
    { supportsFork: false },
    { connectionId: null },
    { connectionReady: false },
    { isViewer: true },
  ])("disables unavailable creation: %j", (overrides) => {
    render(view(overrides))
    expect(screen.getByRole("button", { name: "New research" })).toBeDisabled()
  })

  it.each([
    [{ connectionId: null, supportsFork: false }, "connectionRequired"],
    [{ connectionReady: false, supportsFork: false }, "connectionPending"],
    [{ isViewer: true, supportsFork: false }, "viewer"],
    [{ supportsFork: false }, "unsupported"],
  ] as const)(
    "explains unavailable creation accurately: %j",
    async (overrides, key) => {
      render(view(overrides))
      await expand()
      expect(
        screen.getByRole("button", { name: "New research" }).parentElement
      ).toHaveAttribute("title", enMessages.ResearchBranch[key])
      if (key !== "unsupported") {
        expect(
          screen.queryByText(enMessages.ResearchBranch.unsupported)
        ).not.toBeInTheDocument()
      }
    }
  )

  it("creates once with a UUID and opens the normal conversation", async () => {
    const pending = deferred<ResearchBranchInfo>()
    api.create.mockReturnValue(pending.promise)
    render(view())
    await expand()
    const button = screen.getByRole("button", { name: "New research" })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(api.create).toHaveBeenCalledWith({
      connectionId: "connection-1",
      sourceConversationId: 10,
      requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4/),
    })
    expect(
      screen.getByRole("dialog", {
        name: enMessages.ResearchBranch.forking,
      })
    ).toHaveAttribute("aria-busy", "true")
    await act(async () => pending.resolve(info()))
    expect(onCreated).toHaveBeenCalledWith(info())
    expect(onOpen).toHaveBeenCalledWith(20, true)
  })

  it("keeps the workspace locked until the new conversation opens", async () => {
    const opening = deferred<void>()
    api.create.mockResolvedValue(info())
    onOpen.mockReturnValue(opening.promise)
    render(view())
    await expand()
    await userEvent.click(screen.getByRole("button", { name: "New research" }))
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(20, true))
    expect(
      screen.getByRole("dialog", {
        name: enMessages.ResearchBranch.forking,
      })
    ).toBeInTheDocument()
    await act(async () => opening.resolve())
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    )
  })

  it("blocks create if the source becomes busy after opening the panel", async () => {
    const rendered = render(view())
    await expand()
    rendered.rerender(view({ busy: true }))
    expect(screen.getByRole("button", { name: "New research" })).toBeDisabled()
    expect(api.create).not.toHaveBeenCalled()
  })

  it("retries a failed creation with the same UUID to recover an existing fork", async () => {
    api.create
      .mockRejectedValueOnce(new Error("fork unavailable"))
      .mockResolvedValue(info())
    render(view())
    await expand()
    await userEvent.click(screen.getByRole("button", { name: "New research" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "fork unavailable"
    )
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(onCreated).toHaveBeenCalledWith(info())
    expect(api.create.mock.calls[0][0].requestId).toBe(
      api.create.mock.calls[1][0].requestId
    )
  })

  it("shows source branches with open and existing right-split callbacks", async () => {
    api.list.mockResolvedValue([info()])
    render(view())
    expect(screen.queryByRole("list")).not.toBeInTheDocument()
    expect(
      screen.queryByText(enMessages.ResearchBranch.boundary)
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(enMessages.ResearchBranch.sharedDirectory)
    ).not.toBeInTheDocument()
    await expand()
    expect(api.list).toHaveBeenCalledWith(10)
    expect(
      screen.getByRole("list", { name: "Research branches" })
    ).toHaveTextContent("Research branch 1")
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(
      screen.getByText(enMessages.ResearchBranch.boundary)
    ).toBeInTheDocument()
    expect(
      screen.getByText(enMessages.ResearchBranch.sharedDirectory)
    ).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole("button", { name: "Research branch 1" })
    )
    expect(screen.queryByRole("list")).not.toBeInTheDocument()
    await openBranches()
    await userEvent.click(screen.getByRole("button", { name: "Split right" }))
    expect(onOpen.mock.calls).toEqual([[20], [20, true]])
  })

  it("reuses an uncertain creation ID after the connection remounts", async () => {
    api.create
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValue(info())
    const rendered = render(view())
    await expand()
    await userEvent.click(screen.getByRole("button", { name: "New research" }))
    await screen.findByRole("alert")
    const firstId = api.create.mock.calls[0][0].requestId
    rendered.rerender(view({ connectionId: "reconnected" }))
    await expand()
    await userEvent.click(screen.getByRole("button", { name: "New research" }))
    expect(api.create.mock.calls[1][0].requestId).toBe(firstId)
    expect(onOpen).toHaveBeenCalledWith(20, true)
  })

  it("identifies a branch by branchConversationId and truncates long source titles", async () => {
    const title = "Source title ".repeat(50).trim()
    api.list.mockResolvedValue([info({ sourceTitle: title })])
    render(view({ conversationId: 20, supportsFork: false, busy: true }))
    await waitFor(() => expect(api.list).toHaveBeenCalledWith(20))
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Return to source" })
      ).toBeEnabled()
    )
    expect(screen.getByTitle(title)).toHaveClass("truncate")
    await userEvent.click(
      screen.getByRole("button", { name: "Return to source" })
    )
    expect(onOpen).toHaveBeenCalledWith(10)
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    await expand()
    expect(
      screen.getByRole("button", { name: "Summarize findings" })
    ).toBeDisabled()
    expect(screen.getByRole("textbox", { name: "Summary draft" })).toHaveValue(
      "Saved finding"
    )
  })

  it("saves manual draft changes without handing them to the source", async () => {
    await showBranch()
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled()
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Manual finding" },
    })
    expect(onReturn).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }))
    expect(api.save).toHaveBeenCalledWith(20, "Manual finding")
    await screen.findByText("Summary draft saved.")
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled()
    expect(onReturn).not.toHaveBeenCalled()
  })

  it("opens findings on demand and retains edits when closed without saving", async () => {
    api.list.mockResolvedValue([info()])
    render(view({ conversationId: 20 }))
    const trigger = await screen.findByRole("button", {
      name: "Bring back findings",
    })
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    await userEvent.click(trigger)
    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      "Bring back findings"
    )
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Keep my draft while reading" },
    })
    await userEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(api.save).not.toHaveBeenCalled()
    expect(onReturn).not.toHaveBeenCalled()
    await userEvent.click(trigger)
    expect(screen.getByRole("textbox")).toHaveValue(
      "Keep my draft while reading"
    )
  })

  it("cancels generation when the findings dialog closes and keeps late results out", async () => {
    const pending = deferred<{ summary: string }>()
    api.generate.mockReturnValue(pending.promise)
    await showBranch()
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "My findings" },
    })
    await userEvent.click(
      screen.getByRole("button", { name: "Summarize findings" })
    )
    const requestId = api.generate.mock.calls[0][0].requestId
    await userEvent.keyboard("{Escape}")
    expect(api.cancel).toHaveBeenCalledWith(requestId)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    await act(async () => pending.resolve({ summary: "Late findings" }))
    await expand()
    expect(screen.getByRole("textbox")).toHaveValue("My findings")
    expect(api.save).not.toHaveBeenCalled()
    expect(onReturn).not.toHaveBeenCalled()
  })

  it("persists the exact draft before handing it to the original source", async () => {
    const pending = deferred<ResearchBranchInfo>()
    api.save.mockReturnValue(pending.promise)
    await showBranch()
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Unsaved finding" },
    })
    await userEvent.click(
      screen.getByRole("button", { name: "Add to source draft" })
    )
    expect(api.save).toHaveBeenCalledWith(20, "Unsaved finding")
    expect(onReturn).not.toHaveBeenCalled()
    expect(screen.getByRole("textbox")).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Add to source draft" })
    ).toBeDisabled()
    await act(async () => pending.resolve(info({ summary: "Unsaved finding" })))
    expect(onReturn).toHaveBeenCalledWith(10, "Unsaved finding")
    expect(onOpen).not.toHaveBeenCalled()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("retries a failed save without losing text or handing off early", async () => {
    api.save.mockRejectedValueOnce(new Error("save unavailable"))
    await showBranch()
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Keep this finding" },
    })
    await userEvent.click(
      screen.getByRole("button", { name: "Add to source draft" })
    )
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "save unavailable"
    )
    expect(screen.getByRole("textbox")).toHaveValue("Keep this finding")
    expect(onReturn).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() =>
      expect(onReturn).toHaveBeenCalledWith(10, "Keep this finding")
    )
  })

  it("counts Unicode code points and prevents overlong or empty handoffs", async () => {
    await showBranch()
    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "😀".repeat(12_000) } })
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled()
    expect(
      screen.getByRole("button", { name: "Add to source draft" })
    ).toBeEnabled()
    fireEvent.change(textarea, { target: { value: "😀".repeat(12_001) } })
    expect(textarea).toHaveAttribute("aria-invalid", "true")
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Add to source draft" })
    ).toBeDisabled()
    fireEvent.change(textarea, { target: { value: "" } })
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled()
    expect(
      screen.getByRole("button", { name: "Add to source draft" })
    ).toBeDisabled()
  })

  it("generates via the real API contract and leaves a reviewable unsaved draft", async () => {
    const pending = deferred<{ summary: string }>()
    api.generate.mockReturnValue(pending.promise)
    await showBranch()
    await userEvent.click(
      screen.getByRole("button", { name: "Summarize findings" })
    )
    expect(api.generate).toHaveBeenCalledWith({
      branchConversationId: 20,
      requestId: expect.any(String),
    })
    expect(screen.getByRole("textbox")).toBeDisabled()
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled()
    await act(async () => pending.resolve({ summary: "Generated finding" }))
    expect(screen.getByRole("textbox")).toHaveValue("Generated finding")
    expect(screen.getByRole("textbox")).toBeEnabled()
    expect(api.save).not.toHaveBeenCalled()
    expect(onReturn).not.toHaveBeenCalled()
  })

  it("ignores cancelled late results so manual edits cannot be overwritten", async () => {
    const pending = deferred<{ summary: string }>()
    api.generate.mockReturnValue(pending.promise)
    await showBranch()
    await userEvent.click(
      screen.getByRole("button", { name: "Summarize findings" })
    )
    const requestId = api.generate.mock.calls[0][0].requestId
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(api.cancel).toHaveBeenCalledWith(requestId)
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Manual after cancel" },
    })
    await act(async () =>
      pending.resolve({ summary: "Stale generated finding" })
    )
    expect(screen.getByRole("textbox")).toHaveValue("Manual after cancel")
    expect(onReturn).not.toHaveBeenCalled()
  })

  it("keeps cancellation retryable without accepting a late generated result", async () => {
    const pending = deferred<{ summary: string }>()
    api.generate.mockReturnValue(pending.promise)
    api.cancel.mockRejectedValueOnce(new Error("cancel unavailable"))
    await showBranch()
    await userEvent.click(
      screen.getByRole("button", { name: "Summarize findings" })
    )
    const requestId = api.generate.mock.calls[0][0].requestId
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "cancel unavailable"
    )
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Still mine" },
    })
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(api.cancel.mock.calls).toEqual([[requestId], [requestId]])
    await act(async () => pending.resolve({ summary: "Discard me" }))
    expect(screen.getByRole("textbox")).toHaveValue("Still mine")
  })

  it("retries summary generation without discarding the existing draft on failure", async () => {
    api.generate
      .mockRejectedValueOnce(new Error("summary unavailable"))
      .mockResolvedValue({ summary: "Retry finding" })
    await showBranch()
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "My current draft" },
    })
    await userEvent.click(
      screen.getByRole("button", { name: "Summarize findings" })
    )
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "summary unavailable"
    )
    expect(screen.getByRole("textbox")).toHaveValue("My current draft")
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveValue("Retry finding")
    )
    expect(api.save).not.toHaveBeenCalled()
  })

  it("does not allow an older cancelled request to clear a newer generation", async () => {
    const first = deferred<{ summary: string }>()
    const second = deferred<{ summary: string }>()
    api.generate
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    await showBranch()
    await userEvent.click(
      screen.getByRole("button", { name: "Summarize findings" })
    )
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await userEvent.click(
      screen.getByRole("button", { name: "Summarize findings" })
    )
    await act(async () => first.resolve({ summary: "Old generation" }))
    expect(screen.getByRole("textbox")).toBeDisabled()
    expect(screen.getByRole("textbox")).toHaveValue("Saved finding")
    await act(async () => second.resolve({ summary: "Newest generation" }))
    expect(screen.getByRole("textbox")).toBeEnabled()
    expect(screen.getByRole("textbox")).toHaveValue("Newest generation")
  })

  it("rejects an overlong generated summary without truncating or replacing the draft", async () => {
    api.generate.mockResolvedValue({ summary: "😀".repeat(12_001) })
    await showBranch()
    await userEvent.click(
      screen.getByRole("button", { name: "Summarize findings" })
    )
    expect(await screen.findByRole("alert")).toHaveTextContent(
      enMessages.ResearchBranch.tooLong
    )
    expect(screen.getByRole("textbox")).toHaveValue("Saved finding")
    expect(api.save).not.toHaveBeenCalled()
  })

  it("cancels on conversation change and ignores late summary results", async () => {
    const pending = deferred<{ summary: string }>()
    api.generate.mockReturnValue(pending.promise)
    const rendered = await showBranch()
    await userEvent.click(
      screen.getByRole("button", { name: "Summarize findings" })
    )
    const requestId = api.generate.mock.calls[0][0].requestId
    api.list.mockResolvedValue([
      info({
        id: 2,
        sourceConversationId: 30,
        branchConversationId: 40,
        summary: "Other branch",
      }),
    ])
    rendered.rerender(view({ conversationId: 40 }))
    await expand()
    expect(api.cancel).toHaveBeenCalledWith(requestId)
    await act(async () => pending.resolve({ summary: "Wrong branch finding" }))
    expect(screen.getByRole("textbox")).toHaveValue("Other branch")
  })

  it("cancels an in-flight summary on unmount", async () => {
    const pending = deferred<{ summary: string }>()
    api.generate.mockReturnValue(pending.promise)
    const rendered = await showBranch()
    await userEvent.click(
      screen.getByRole("button", { name: "Summarize findings" })
    )
    const requestId = api.generate.mock.calls[0][0].requestId
    rendered.unmount()
    expect(api.cancel).toHaveBeenCalledWith(requestId)
    expect(api.unsubscribe).toHaveBeenCalled()
    await act(async () => pending.reject(new Error("late cancellation")))
  })

  it("keeps unsaved summary edits when a reconnect remounts its panel", async () => {
    const rendered = await showBranch()
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Unsaved finding" },
    })
    rendered.rerender(
      view({ conversationId: 20, connectionId: "new-connection" })
    )
    await expand()
    expect(screen.getByRole("textbox")).toHaveValue("Unsaved finding")
  })

  it("isolates a changed connection even when the conversation ID stays the same", async () => {
    const pending = deferred<{ summary: string }>()
    api.generate.mockReturnValue(pending.promise)
    const rendered = await showBranch()
    await userEvent.click(
      screen.getByRole("button", { name: "Summarize findings" })
    )
    const requestId = api.generate.mock.calls[0][0].requestId
    rendered.rerender(
      view({ conversationId: 20, connectionId: "reconnected-session" })
    )
    await expand()
    expect(api.cancel).toHaveBeenCalledWith(requestId)
    await act(async () => pending.resolve({ summary: "From old connection" }))
    expect(screen.getByRole("textbox")).toHaveValue("Saved finding")
  })

  it("does not hand a late save to a different source after switching conversations", async () => {
    const pending = deferred<ResearchBranchInfo>()
    api.save.mockReturnValue(pending.promise)
    const rendered = await showBranch()
    await userEvent.click(
      screen.getByRole("button", { name: "Add to source draft" })
    )
    api.list.mockResolvedValue([
      info({
        id: 2,
        sourceConversationId: 30,
        branchConversationId: 40,
        summary: "New source finding",
      }),
    ])
    rendered.rerender(view({ conversationId: 40 }))
    await expand()
    await act(async () => pending.resolve(info()))
    expect(onReturn).not.toHaveBeenCalled()
    expect(screen.getByRole("textbox")).toHaveValue("New source finding")
  })

  it("recovers from load errors with explicit retry", async () => {
    api.list.mockRejectedValueOnce(new Error("offline"))
    render(view())
    await expand()
    expect(await screen.findByRole("alert")).toHaveTextContent("offline")
    expect(screen.getByRole("button", { name: "New research" })).toBeDisabled()
    api.list.mockResolvedValue([info()])
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    await screen.findByText("Research branch 1")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "New research" })).toBeEnabled()
  })

  it("keeps relation-load retry accessible when the agent cannot create branches", async () => {
    api.list.mockRejectedValueOnce(new Error("relations offline"))
    render(view({ conversationId: 20, supportsFork: false, busy: true }))
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Research branches" })
      ).toBeEnabled()
    )
    await expand()
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "relations offline"
    )
    api.list.mockResolvedValue([info()])
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(
      await screen.findByRole("button", { name: "Return to source" })
    ).toBeEnabled()
    expect(
      screen.queryByRole("button", { name: "New research" })
    ).not.toBeInTheDocument()
    expect(
      screen
        .getAllByText(enMessages.ResearchBranch.waitForCompletion)
        .some((element) => !element.classList.contains("sr-only"))
    ).toBe(true)
    await openBranches()
    await userEvent.click(
      screen.getByRole("button", { name: "Bring back findings" })
    )
    expect(screen.getByRole("textbox")).toHaveValue("Saved finding")
  })

  it("reloads on reconnect or refresh, not prop/token-like rerenders, preserving unsaved edits", async () => {
    const rendered = await showBranch()
    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "Local draft" } })
    rendered.rerender(view({ conversationId: 20, busy: true }))
    rendered.rerender(view({ conversationId: 20, busy: false }))
    expect(api.list).toHaveBeenCalledTimes(1)
    api.list.mockResolvedValue([info({ summary: "Remote update" })])
    await act(async () => api.onReconnect.mock.calls[0][0]())
    expect(api.list).toHaveBeenCalledTimes(2)
    expect(textarea).toHaveValue("Local draft")
    await userEvent.click(screen.getByRole("button", { name: "Close" }))
    await openBranches()
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }))
    expect(api.list).toHaveBeenCalledTimes(3)
    await openBranches()
    await expand()
    expect(screen.getByRole("textbox")).toHaveValue("Local draft")
  })

  it("ignores a stale relationship load after changing conversations", async () => {
    const oldLoad = deferred<ResearchBranchInfo[]>()
    api.list
      .mockReturnValueOnce(oldLoad.promise)
      .mockResolvedValue([
        info({ branchConversationId: 40, summary: "Current draft" }),
      ])
    const rendered = render(view())
    rendered.rerender(view({ conversationId: 40 }))
    await expand()
    await act(async () => oldLoad.resolve([info()]))
    expect(screen.getByRole("textbox")).toHaveValue("Current draft")
  })

  it("never submits a parent composer form from panel buttons", async () => {
    api.list.mockResolvedValue([info()])
    const onSubmit = vi.fn((event) => event.preventDefault())
    render(<form onSubmit={onSubmit}>{view({ conversationId: 20 })}</form>)
    await userEvent.click(
      await screen.findByRole("button", { name: "Return to source" })
    )
    await expand()
    screen
      .getAllByRole("button")
      .forEach((button) => expect(button).toHaveAttribute("type", "button"))
    await userEvent.click(screen.getByRole("button", { name: "Close" }))
    await openBranches()
    screen
      .getAllByRole("button")
      .forEach((button) => expect(button).toHaveAttribute("type", "button"))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("settles relationship loading under React StrictMode", async () => {
    api.list.mockResolvedValue([info()])
    render(<StrictMode>{view({ conversationId: 20 })}</StrictMode>)
    await expand()
    expect(screen.getByRole("textbox")).toHaveValue("Saved finding")
  })
})

describe("research branch translations", () => {
  it.each([
    ["ar", arMessages],
    ["de", deMessages],
    ["es", esMessages],
    ["fr", frMessages],
    ["ja", jaMessages],
    ["ko", koMessages],
    ["pt", ptMessages],
    ["zh-CN", zhMessages],
    ["zh-TW", twMessages],
  ] as const)("has complete, nonempty keys in %s", (_locale, messages) => {
    expect(Object.keys(messages.ResearchBranch).sort()).toEqual(
      Object.keys(enMessages.ResearchBranch).sort()
    )
    Object.values(messages.ResearchBranch).forEach((text) =>
      expect(text.trim()).not.toBe("")
    )
    expect(messages.ResearchBranch.characterCount).toContain("{count}")
    expect(messages.ResearchBranch.characterCount).toContain("{max}")
  })
})

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
  getTransport: () => ({ onReconnect: api.onReconnect }),
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
        canCreate
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
  await userEvent.click(screen.getByRole("button", { name: "Research branch" }))
  await waitFor(() =>
    expect(
      screen.queryByText("Loading research branches…")
    ).not.toBeInTheDocument()
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
  it("does not render or fetch for drafts and virtual conversation IDs", () => {
    const rendered = render(view({ conversationId: null }))
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    rendered.rerender(view({ conversationId: -1 }))
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(api.list).not.toHaveBeenCalled()
  })

  it("disables the busy entry and explicitly asks to wait for completion", async () => {
    render(view({ busy: true }))
    expect(
      screen.getByRole("button", { name: "Research branch" })
    ).toBeDisabled()
    expect(
      screen.getByText(enMessages.ResearchBranch.waitForCompletion)
    ).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole("button", { name: "Research branch" })
    )
    expect(api.create).not.toHaveBeenCalled()
  })

  it.each([{ canCreate: false }, { connectionId: null }])(
    "disables unavailable creation: %j",
    (overrides) => {
      render(view(overrides))
      expect(
        screen.getByRole("button", { name: "Research branch" })
      ).toBeDisabled()
    }
  )

  it("creates once with a UUID and opens the normal conversation", async () => {
    const pending = deferred<ResearchBranchInfo>()
    api.create.mockReturnValue(pending.promise)
    render(view())
    await expand()
    const button = screen.getByRole("button", { name: "Create branch" })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(api.create).toHaveBeenCalledWith({
      connectionId: "connection-1",
      sourceConversationId: 10,
      requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4/),
    })
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled()
    await act(async () => pending.resolve(info()))
    expect(onCreated).toHaveBeenCalledWith(info())
    expect(onOpen).toHaveBeenCalledWith(20, true)
  })

  it("blocks create if the source becomes busy after opening the panel", async () => {
    const rendered = render(view())
    await expand()
    rendered.rerender(view({ busy: true }))
    expect(screen.getByRole("button", { name: "Create branch" })).toBeDisabled()
    expect(api.create).not.toHaveBeenCalled()
  })

  it("retries a failed creation with the same UUID to recover an existing fork", async () => {
    api.create
      .mockRejectedValueOnce(new Error("fork unavailable"))
      .mockResolvedValue(info())
    render(view())
    await expand()
    await userEvent.click(screen.getByRole("button", { name: "Create branch" }))
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
    await expand()
    expect(api.list).toHaveBeenCalledWith(10)
    expect(
      screen.getByRole("list", { name: "Research branches" })
    ).toHaveTextContent("Research branch 1")
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Open" }))
    await userEvent.click(screen.getByRole("button", { name: "Split right" }))
    expect(onOpen.mock.calls).toEqual([[20], [20, true]])
    expect(
      screen.getByText(enMessages.ResearchBranch.boundary)
    ).toBeInTheDocument()
    expect(
      screen.getByText(enMessages.ResearchBranch.sharedDirectory)
    ).toBeInTheDocument()
  })

  it("reuses an uncertain creation ID after the connection remounts", async () => {
    api.create
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValue(info())
    const rendered = render(view())
    await expand()
    await userEvent.click(screen.getByRole("button", { name: "Create branch" }))
    await screen.findByRole("alert")
    const firstId = api.create.mock.calls[0][0].requestId
    rendered.rerender(view({ connectionId: "reconnected" }))
    await expand()
    await userEvent.click(screen.getByRole("button", { name: "Create branch" }))
    expect(api.create.mock.calls[1][0].requestId).toBe(firstId)
    expect(onOpen).toHaveBeenCalledWith(20, true)
  })

  it("identifies a branch by branchConversationId and truncates long source titles", async () => {
    const title = "Source title ".repeat(50).trim()
    api.list.mockResolvedValue([info({ sourceTitle: title })])
    render(view({ conversationId: 20, canCreate: false, busy: true }))
    await waitFor(() => expect(api.list).toHaveBeenCalledWith(20))
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Research branch" })
      ).toBeEnabled()
    )
    await expand()
    expect(screen.getByTitle(title)).toHaveClass("truncate")
    await userEvent.click(
      screen.getByRole("button", { name: "Return to source" })
    )
    expect(onOpen).toHaveBeenCalledWith(10)
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

  it("persists the exact draft before handing it to the original source", async () => {
    const pending = deferred<ResearchBranchInfo>()
    api.save.mockReturnValue(pending.promise)
    await showBranch()
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Unsaved finding" },
    })
    await userEvent.click(
      screen.getByRole("button", { name: "Bring back to source" })
    )
    expect(api.save).toHaveBeenCalledWith(20, "Unsaved finding")
    expect(onReturn).not.toHaveBeenCalled()
    expect(screen.getByRole("textbox")).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Bring back to source" })
    ).toBeDisabled()
    await act(async () => pending.resolve(info({ summary: "Unsaved finding" })))
    expect(onReturn).toHaveBeenCalledWith(10, "Unsaved finding")
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("retries a failed save without losing text or handing off early", async () => {
    api.save.mockRejectedValueOnce(new Error("save unavailable"))
    await showBranch()
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Keep this finding" },
    })
    await userEvent.click(
      screen.getByRole("button", { name: "Bring back to source" })
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
      screen.getByRole("button", { name: "Bring back to source" })
    ).toBeEnabled()
    fireEvent.change(textarea, { target: { value: "😀".repeat(12_001) } })
    expect(textarea).toHaveAttribute("aria-invalid", "true")
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Bring back to source" })
    ).toBeDisabled()
    fireEvent.change(textarea, { target: { value: "" } })
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled()
    expect(
      screen.getByRole("button", { name: "Bring back to source" })
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
      screen.getByRole("button", { name: "Bring back to source" })
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
    expect(screen.getByRole("button", { name: "Create branch" })).toBeDisabled()
    api.list.mockResolvedValue([info()])
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    await screen.findByText("Research branch 1")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Create branch" })).toBeEnabled()
  })

  it("keeps relation-load retry accessible when the agent cannot create branches", async () => {
    api.list.mockRejectedValueOnce(new Error("relations offline"))
    render(view({ conversationId: 20, canCreate: false, busy: true }))
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Research branch" })
      ).toBeEnabled()
    )
    await expand()
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "relations offline"
    )
    api.list.mockResolvedValue([info()])
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(await screen.findByRole("textbox")).toHaveValue("Saved finding")
    expect(screen.getByRole("button", { name: "Create branch" })).toBeDisabled()
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
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }))
    expect(api.list).toHaveBeenCalledTimes(3)
    expect(textarea).toHaveValue("Local draft")
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
    await expand()
    screen
      .getAllByRole("button")
      .forEach((button) => expect(button).toHaveAttribute("type", "button"))
    await userEvent.click(
      screen.getByRole("button", { name: "Return to source" })
    )
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

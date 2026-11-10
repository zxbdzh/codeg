import type { ReactNode } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { SideQuestionAnswer } from "@/lib/side-question"

const scene = vi.hoisted(() => ({
  isOpen: true,
  activeTab: "side_question",
  activeTabId: "tab-1",
  tabs: [
    {
      id: "tab-1",
      folderId: 1,
      agentType: "codex",
      conversationId: 12,
      title: "Main conversation",
    },
    {
      id: "tab-2",
      folderId: 1,
      agentType: "pi",
      conversationId: 13,
      title: "Other conversation",
    },
  ],
  call: vi.fn(),
  getTimelineTurns: vi.fn(() => []),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: scene.call }),
}))
vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => ({
    isOpen: scene.isOpen,
    activeTab: scene.activeTab,
  }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabStore: (select: (state: typeof scene) => unknown) => select(scene),
}))
vi.mock("@/stores/conversation-runtime-store", () => ({
  getTimelineTurns: scene.getTimelineTurns,
}))
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

import { SideQuestionTab } from "./aux-panel-side-question-tab"
import {
  resetSideQuestions,
  useSideQuestionStore,
} from "@/stores/side-question-store"

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SideQuestionTab />
    </NextIntlClientProvider>
  )
}

function enterQuestion(text = "What does this mean?") {
  fireEvent.change(screen.getByRole("textbox", { name: "Question" }), {
    target: { value: text },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const answer: SideQuestionAnswer = {
  answer: "Independent answer",
  agentType: "claude_code",
  contextMessages: 0,
  contextChars: 0,
  selectionChars: 0,
}

describe("SideQuestionTab", () => {
  beforeEach(() => {
    resetSideQuestions()
    scene.isOpen = true
    scene.activeTab = "side_question"
    scene.activeTabId = "tab-1"
    scene.call.mockReset()
    scene.call.mockResolvedValue(answer)
    scene.getTimelineTurns.mockClear()
  })

  it("states the execution engine and limited context for a non-Claude source", () => {
    renderTab()
    expect(screen.getByText("Claude Code · No tools")).toBeInTheDocument()
    expect(screen.getByText(/Answers stay here/)).toBeInTheDocument()
    expect(
      screen.getByText(/12 messages \/ 12,000 characters/)
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled()
  })

  it("shows the answer only in the independent panel", async () => {
    renderTab()
    enterQuestion()
    fireEvent.click(screen.getByRole("button", { name: "Ask" }))
    await screen.findByText("Independent answer")
    expect(scene.call).toHaveBeenCalledTimes(1)
    expect(scene.call.mock.calls[0][0]).toBe("side_question_ask")
    expect(scene.getTimelineTurns).toHaveBeenCalledWith(12)
  })

  it("keeps normal Enter and IME confirmation from submitting", async () => {
    renderTab()
    enterQuestion()
    const input = screen.getByRole("textbox", { name: "Question" })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true })
    expect(scene.call).not.toHaveBeenCalled()
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true })
    await screen.findByText("Independent answer")
    expect(scene.call).toHaveBeenCalledTimes(1)
  })

  it("rejects an oversized question before starting a provider request", () => {
    renderTab()
    enterQuestion("问".repeat(4_001))
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled()
    expect(screen.getByRole("alert")).toHaveTextContent("4,000")
    expect(scene.call).not.toHaveBeenCalled()
  })

  it("cancels on close and ignores the response that arrives afterwards", async () => {
    const waiting = deferred<SideQuestionAnswer>()
    scene.call.mockImplementation((command: string) =>
      command === "side_question_ask" ? waiting.promise : Promise.resolve()
    )
    const view = renderTab()
    enterQuestion()
    fireEvent.click(screen.getByRole("button", { name: "Ask" }))
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
    scene.isOpen = false
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SideQuestionTab />
      </NextIntlClientProvider>
    )
    expect(scene.call).toHaveBeenCalledWith("side_question_cancel", {
      requestId: expect.any(String),
    })
    await act(async () => waiting.resolve(answer))
    expect(screen.queryByText("Independent answer")).toBeNull()
  })

  it("cancels once without submitting the replacement Ask button", async () => {
    const waiting = deferred<SideQuestionAnswer>()
    scene.call.mockImplementation((command: string) =>
      command === "side_question_ask" ? waiting.promise : Promise.resolve()
    )
    renderTab()
    enterQuestion()
    fireEvent.click(screen.getByRole("button", { name: "Ask" }))
    const cancel = screen.getByRole("button", { name: "Cancel" })
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    })
    fireEvent(cancel, click)
    expect(click.defaultPrevented).toBe(true)
    expect(screen.getByText("Cancelled")).toBeInTheDocument()
    expect(
      scene.call.mock.calls.filter(
        ([command]) => command === "side_question_ask"
      )
    ).toHaveLength(1)
    expect(
      scene.call.mock.calls.filter(
        ([command]) => command === "side_question_cancel"
      )
    ).toHaveLength(1)
    await act(async () => waiting.resolve(answer))
    expect(screen.queryByText("Independent answer")).toBeNull()
    expect(screen.getByText("Cancelled")).toBeInTheDocument()
  })

  it("separates source drafts and cancels a request when the main tab changes", async () => {
    const waiting = deferred<SideQuestionAnswer>()
    scene.call.mockImplementation((command: string) =>
      command === "side_question_ask" ? waiting.promise : Promise.resolve()
    )
    const view = renderTab()
    enterQuestion("First source question")
    fireEvent.click(screen.getByRole("button", { name: "Ask" }))
    scene.activeTabId = "tab-2"
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SideQuestionTab />
      </NextIntlClientProvider>
    )
    expect(screen.getByRole("textbox", { name: "Question" })).toHaveValue("")
    expect(scene.call).toHaveBeenCalledWith("side_question_cancel", {
      requestId: expect.any(String),
    })
    await act(async () => waiting.resolve(answer))
    expect(screen.queryByText("Independent answer")).toBeNull()
  })

  it("uses a captured selection without appending recent conversation text", async () => {
    useSideQuestionStore
      .getState()
      .setSelection("tab-1:1:codex", "Chosen passage")
    renderTab()
    expect(
      screen.getByText(/Only the selected text is sent/)
    ).toBeInTheDocument()
    enterQuestion()
    fireEvent.click(screen.getByRole("button", { name: "Ask" }))
    await waitFor(() => {
      expect(scene.call).toHaveBeenCalledWith(
        "side_question_ask",
        expect.objectContaining({ selection: "Chosen passage", context: [] }),
        expect.anything()
      )
    })
  })
})

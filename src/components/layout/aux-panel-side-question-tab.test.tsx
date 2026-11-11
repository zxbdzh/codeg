import type { ReactNode } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { ConnectionState } from "@/contexts/acp-connections-context"
import type { TabItem } from "@/contexts/tab-context"
import type { SideQuestionAnswer } from "@/lib/side-question"
import type {
  RichComposerHandle,
  RichComposerProps,
} from "@/components/chat/composer/rich-composer"

type TestConnection = Pick<
  ConnectionState,
  | "connectionId"
  | "agentType"
  | "status"
  | "selectorsReady"
  | "configOptions"
  | "isViewer"
  | "configStale"
>

const scene = vi.hoisted(() => ({
  isOpen: true,
  activeTab: "side_question",
  activeTabId: "tab-1",
  tabs: [] as TabItem[],
  hasConnectionStore: true,
  connections: {} as Record<string, TestConnection | undefined>,
  listeners: new Map<string, Set<() => void>>(),
  connectionStore: {
    getConnection: vi.fn(),
    subscribeKey: vi.fn(),
  },
  call: vi.fn(),
  copyText: vi.fn(),
  readAttachment: vi.fn(),
  toastError: vi.fn(),
  getTimelineTurns: vi.fn(() => []),
  editorSubmit: null as (() => void) | null,
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: scene.call }),
}))
vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  copyTextToClipboard: scene.copyText,
}))
vi.mock("sonner", () => ({ toast: { error: scene.toastError } }))
vi.mock("@/lib/side-question-attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/side-question-attachments")>()),
  readSideQuestionAttachment: scene.readAttachment,
}))
vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => ({
    isOpen: scene.isOpen,
    activeTab: scene.activeTab,
  }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabStore: Object.assign(
    (select: (state: typeof scene) => unknown) => select(scene),
    { getState: () => scene }
  ),
}))
vi.mock("@/contexts/acp-connections-context", () => ({
  useOptionalConnectionStore: () =>
    scene.hasConnectionStore ? scene.connectionStore : null,
}))
vi.mock("@/stores/conversation-runtime-store", () => ({
  getTimelineTurns: scene.getTimelineTurns,
}))
vi.mock("@/components/ai-elements/message", () => ({
  Message: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MessageContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  MessageResponse: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}))
vi.mock("@/components/chat/composer/rich-composer", async () => {
  const React = await import("react")
  return {
    RichComposer: React.forwardRef<RichComposerHandle, RichComposerProps>(
      function EditorStub(props, ref) {
        const [text, setText] = React.useState(props.defaultText ?? "")
        const input = React.useRef<HTMLTextAreaElement>(null)
        React.useImperativeHandle(
          ref,
          () => ({
            getText: () => text,
            setText,
            clear: () => setText(""),
            focus: () => input.current?.focus(),
            focusAtCoords: () => input.current?.focus(),
            isEmpty: () => !text,
            getJSON: () => ({ type: "doc" }),
            getEditor: () => null,
            setDoc: () => {},
            insertTextAtCursor: () => {},
            insertReference: () => {},
          }),
          [text]
        )
        const { onReady, onSubmit } = props
        React.useEffect(() => {
          onReady?.()
          scene.editorSubmit = onSubmit ?? null
        }, [onReady, onSubmit])
        return (
          <textarea
            ref={input}
            aria-label={props.ariaLabel}
            value={text}
            disabled={props.disabled}
            data-shared-composer
            onChange={(event) => {
              setText(event.target.value)
              props.onChange?.(event.target.value)
            }}
            onPaste={(event) => props.onPasteFiles?.(event.nativeEvent)}
          />
        )
      }
    ),
  }
})
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

function dropFiles(files: File[]) {
  fireEvent.drop(screen.getByRole("textbox", { name: "Question" }), {
    dataTransfer: { types: ["Files"], files },
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
  agentType: "codex",
  contextMessages: 0,
  contextChars: 0,
  selectionChars: 0,
}

function connection(overrides: Partial<TestConnection> = {}): TestConnection {
  return {
    connectionId: "codex-connection",
    agentType: "codex",
    status: "connected",
    selectorsReady: true,
    isViewer: false,
    configStale: false,
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        kind: {
          type: "select",
          current_value: "codex-model",
          options: [{ value: "codex-model", name: "Current Codex model" }],
          groups: [],
        },
      },
    ],
    ...overrides,
  }
}

function updateConnection(next: TestConnection | undefined, tabId = "tab-1") {
  act(() => {
    scene.connections[tabId] = next
    scene.listeners.get(tabId)?.forEach((listener) => listener())
  })
}

describe("SideQuestionTab", () => {
  beforeEach(() => {
    resetSideQuestions()
    scene.isOpen = true
    scene.activeTab = "side_question"
    scene.activeTabId = "tab-1"
    scene.tabs = [
      {
        id: "tab-1",
        kind: "conversation",
        isPinned: false,
        folderId: 1,
        agentType: "codex",
        conversationId: 12,
        title: "Main conversation",
      },
      {
        id: "tab-2",
        kind: "conversation",
        isPinned: false,
        folderId: 1,
        agentType: "pi",
        conversationId: 13,
        title: "Other conversation",
      },
    ]
    scene.hasConnectionStore = true
    scene.connections = { "tab-1": connection() }
    scene.listeners.clear()
    scene.connectionStore.getConnection.mockReset()
    scene.connectionStore.getConnection.mockImplementation(
      (key: string) => scene.connections[key]
    )
    scene.connectionStore.subscribeKey.mockReset()
    scene.connectionStore.subscribeKey.mockImplementation(
      (key: string, listener: () => void) => {
        const listeners = scene.listeners.get(key) ?? new Set<() => void>()
        listeners.add(listener)
        scene.listeners.set(key, listeners)
        return () => listeners.delete(listener)
      }
    )
    scene.call.mockReset()
    scene.call.mockResolvedValue(answer)
    scene.copyText.mockReset().mockResolvedValue(true)
    scene.readAttachment.mockReset().mockImplementation(async (file: File) => ({
      type: "image",
      id: file.name,
      name: file.name,
      data: "image-data",
      mimeType: "image/png",
      bytes: file.size,
    }))
    scene.toastError.mockReset()
    scene.getTimelineTurns.mockClear()
  })

  it("follows the selected Codex model and keeps the composer actions minimal", () => {
    renderTab()
    expect(
      screen.getByText("Follow current conversation · Current Codex model")
    ).toBeInTheDocument()
    expect(screen.getByText(/Answers stay here/)).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Attach images or text files" })
    ).toBeNull()
    expect(
      screen.queryByText(enMessages.Folder.sideQuestion.contextLabel)
    ).toBeNull()
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled()
  })

  it("shows the answer only in the independent panel", async () => {
    renderTab()
    enterQuestion()
    fireEvent.click(screen.getByRole("button", { name: "Ask" }))
    await screen.findByText("Independent answer")
    expect(scene.call).toHaveBeenCalledTimes(1)
    expect(scene.call.mock.calls[0][0]).toBe("side_question_ask")
    expect(scene.call.mock.calls[0][1]).toEqual({
      requestId: expect.any(String),
      question: "What does this mean?",
      selection: null,
      context: [],
      sourceConnectionId: "codex-connection",
      sourceConversationId: 12,
      sourceAgentType: "codex",
    })
    expect(scene.getTimelineTurns).toHaveBeenCalledWith(12)
  })

  it("uploads an image, allows an image-only question, and sends bytes without paths", async () => {
    renderTab()
    const file = new File(["image"], "screen.png", { type: "image/png" })
    dropFiles([file])
    await screen.findByAltText("screen.png")
    fireEvent.click(screen.getByRole("button", { name: "Ask" }))
    await screen.findByText("Independent answer")
    expect(scene.call).toHaveBeenCalledWith(
      "side_question_ask",
      expect.objectContaining({
        question: "",
        attachments: [
          {
            type: "image",
            name: "screen.png",
            mimeType: "image/png",
            data: "image-data",
          },
        ],
      }),
      expect.anything()
    )
  })

  it("accepts pasted and dropped files and removes an attachment before asking", async () => {
    renderTab()
    const first = new File(["image"], "paste.png", { type: "image/png" })
    fireEvent.paste(screen.getByRole("textbox", { name: "Question" }), {
      clipboardData: { files: [first], items: [], getData: () => "" },
    })
    await screen.findByAltText("paste.png")
    const second = new File(["image"], "drop.png", { type: "image/png" })
    fireEvent.drop(screen.getByRole("region", { name: "Side question" }), {
      dataTransfer: { types: ["Files"], files: [second] },
    })
    await screen.findByAltText("drop.png")
    fireEvent.click(screen.getByRole("button", { name: "Remove paste.png" }))
    expect(screen.queryByAltText("paste.png")).toBeNull()
    expect(screen.getByAltText("drop.png")).toBeInTheDocument()
  })

  it("blocks sending during a file read and discards its result after clearing", async () => {
    const read =
      deferred<
        Awaited<
          ReturnType<
            typeof import("@/lib/side-question-attachments").readSideQuestionAttachment
          >
        >
      >()
    scene.readAttachment.mockReturnValue(read.promise)
    renderTab()
    enterQuestion()
    dropFiles([new File(["image"], "late.png", { type: "image/png" })])
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Clear side question" }))
    await act(async () =>
      read.resolve({
        type: "image",
        id: "late",
        name: "late.png",
        mimeType: "image/png",
        data: "late",
        bytes: 4,
      })
    )
    expect(screen.queryByAltText("late.png")).toBeNull()
    expect(scene.call).not.toHaveBeenCalled()
  })

  it("copies the answer and reports a clipboard failure without losing it", async () => {
    renderTab()
    enterQuestion()
    fireEvent.click(screen.getByRole("button", { name: "Ask" }))
    await screen.findByText("Independent answer")
    scene.copyText.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }))
    await waitFor(() => expect(scene.toastError).toHaveBeenCalledTimes(1))
    expect(screen.getByText("Independent answer")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }))
    await screen.findByRole("button", { name: "Copied" })
    expect(scene.copyText).toHaveBeenCalledWith("Independent answer")
  })

  it("never transfers a late file read into a different conversation", async () => {
    const read =
      deferred<
        Awaited<
          ReturnType<
            typeof import("@/lib/side-question-attachments").readSideQuestionAttachment
          >
        >
      >()
    scene.readAttachment.mockReturnValueOnce(read.promise)
    scene.tabs[1] = { ...scene.tabs[1], agentType: "codex" }
    scene.connections["tab-2"] = connection()
    const view = renderTab()
    dropFiles([new File(["first"], "old.png", { type: "image/png" })])
    scene.activeTabId = "tab-2"
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SideQuestionTab />
      </NextIntlClientProvider>
    )
    dropFiles([new File(["second"], "new.png", { type: "image/png" })])
    await screen.findByAltText("new.png")
    await act(async () =>
      read.resolve({
        type: "image",
        id: "old",
        name: "old.png",
        mimeType: "image/png",
        data: "old",
        bytes: 5,
      })
    )
    expect(screen.queryByAltText("old.png")).toBeNull()
    expect(
      useSideQuestionStore.getState().bySource["tab-1:1:codex"]?.attachments ??
        []
    ).toEqual([])
    expect(screen.getByRole("button", { name: "Ask" })).toBeEnabled()
  })

  it("clears and cancels a pending question without accepting its late answer", async () => {
    const waiting = deferred<SideQuestionAnswer>()
    scene.call.mockImplementation((command: string) =>
      command === "side_question_ask" ? waiting.promise : Promise.resolve()
    )
    renderTab()
    enterQuestion()
    fireEvent.click(screen.getByRole("button", { name: "Ask" }))
    fireEvent.click(screen.getByRole("button", { name: "Clear side question" }))
    expect(screen.getByRole("textbox", { name: "Question" })).toHaveValue("")
    expect(
      screen.getByRole("button", { name: "Clear side question" })
    ).toBeDisabled()
    await act(async () => waiting.resolve(answer))
    expect(screen.queryByText("Independent answer")).toBeNull()
    expect(scene.call).toHaveBeenCalledWith("side_question_cancel", {
      requestId: expect.any(String),
    })
  })

  it("updates the displayed model from grouped options through the tab connection subscription", () => {
    renderTab()
    updateConnection(
      connection({
        configOptions: [
          {
            id: "agent-model",
            name: "Model",
            category: "model",
            kind: {
              type: "select",
              current_value: "grouped-model",
              options: [],
              groups: [
                {
                  group: "provider",
                  name: "Provider",
                  options: [
                    { value: "grouped-model", name: "New selected model" },
                  ],
                },
              ],
            },
          },
        ],
      })
    )
    expect(
      screen.getByText("Follow current conversation · New selected model")
    ).toBeInTheDocument()
    expect(scene.connectionStore.subscribeKey).toHaveBeenCalledWith(
      "tab-1",
      expect.any(Function)
    )
    expect(scene.call).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    "explains a missing connection without a model fallback (store present: %s)",
    (hasStore) => {
      scene.hasConnectionStore = hasStore
      scene.connections = {}
      renderTab()
      enterQuestion()
      expect(
        screen.getByText(/Connect the current conversation first/)
      ).toBeInTheDocument()
      expect(
        screen.getByText("Follow current conversation")
      ).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled()
      fireEvent.keyDown(screen.getByRole("textbox"), {
        key: "Enter",
        ctrlKey: true,
      })
      expect(scene.call).not.toHaveBeenCalled()
    }
  )

  it.each(["connecting", "disconnected", "error"] as const)(
    "disables sending while the connection is %s",
    (status) => {
      scene.connections["tab-1"] = connection({ status })
      renderTab()
      enterQuestion()
      expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled()
      expect(
        screen.getByText(/Connect the current conversation first/)
      ).toBeInTheDocument()
    }
  )

  it("waits for selectors and reacts when they become ready", () => {
    scene.connections["tab-1"] = connection({ selectorsReady: false })
    renderTab()
    enterQuestion()
    expect(
      screen.getByText(/Syncing the current conversation's model settings/)
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled()
    updateConnection(connection())
    expect(screen.getByRole("button", { name: "Ask" })).toBeEnabled()
  })

  it("shows the selected model identifier when no display label is advertised", () => {
    const current = connection()
    if (current.configOptions?.[0].kind.type === "select") {
      current.configOptions[0].kind.options = []
    }
    scene.connections["tab-1"] = current
    renderTab()
    expect(
      screen.getByText("Follow current conversation · codex-model")
    ).toBeInTheDocument()
  })

  it("waits for a real model instead of sending with an unknown default", () => {
    scene.connections["tab-1"] = connection({ configOptions: null })
    renderTab()
    expect(screen.getByText("Follow current conversation")).toBeInTheDocument()
    expect(screen.queryByText(/Follow current conversation ·/)).toBeNull()
    enterQuestion()
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Ask" }))
    expect(scene.call).not.toHaveBeenCalled()
  })

  it("disables asking with no active tab", () => {
    scene.activeTabId = "missing"
    renderTab()
    expect(
      screen.getByText("Select a conversation to ask a side question.")
    ).toBeInTheDocument()
    expect(screen.getByRole("textbox")).toBeDisabled()
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled()
    expect(scene.connectionStore.subscribeKey).not.toHaveBeenCalled()
  })

  it("rejects a connection belonging to another agent", () => {
    scene.connections["tab-1"] = connection({ agentType: "claude_code" })
    renderTab()
    enterQuestion()
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled()
    expect(
      screen.getByText(/Connect the current conversation first/)
    ).toBeInTheDocument()
    expect(screen.queryByText(/Follow current conversation ·/)).toBeNull()
  })

  it("shows unsupported agents explicitly even with a ready connection", () => {
    scene.activeTabId = "tab-2"
    scene.connections["tab-2"] = connection({ agentType: "pi" })
    renderTab()
    enterQuestion()
    expect(
      screen.getByText(/Following this agent is not supported yet/)
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled()
    expect(screen.queryByText(/Follow current conversation ·/)).toBeNull()
    expect(scene.call).not.toHaveBeenCalled()
  })

  it.each(["connected", "prompting"] as const)(
    "allows a Claude viewer to ask while %s",
    async (status) => {
      scene.tabs[0] = { ...scene.tabs[0], agentType: "claude_code" }
      scene.connections["tab-1"] = connection({
        connectionId: "claude-connection",
        agentType: "claude_code",
        isViewer: true,
        status,
      })
      renderTab()
      enterQuestion()
      fireEvent.click(screen.getByRole("button", { name: "Ask" }))
      await screen.findByText("Independent answer")
      expect(scene.call).toHaveBeenCalledWith(
        "side_question_ask",
        expect.objectContaining({
          sourceConnectionId: "claude-connection",
          sourceAgentType: "claude_code",
        }),
        expect.anything()
      )
    }
  )

  it("sends a null persisted source for a draft while reading its runtime context", async () => {
    scene.tabs[0] = {
      ...scene.tabs[0],
      conversationId: null,
      runtimeConversationId: -12,
    }
    renderTab()
    enterQuestion()
    fireEvent.click(screen.getByRole("button", { name: "Ask" }))
    await screen.findByText("Independent answer")
    expect(scene.getTimelineTurns).toHaveBeenCalledWith(-12)
    expect(scene.call).toHaveBeenCalledWith(
      "side_question_ask",
      expect.objectContaining({ sourceConversationId: null }),
      expect.anything()
    )
  })

  it("re-reads the connection and persisted source at submit time", async () => {
    renderTab()
    enterQuestion()
    scene.connections["tab-1"] = connection({
      connectionId: "replacement-connection",
    })
    scene.tabs[0] = { ...scene.tabs[0], conversationId: 42 }
    fireEvent.click(screen.getByRole("button", { name: "Ask" }))
    await screen.findByText("Independent answer")
    expect(scene.call).toHaveBeenCalledWith(
      "side_question_ask",
      expect.objectContaining({
        sourceConnectionId: "replacement-connection",
        sourceConversationId: 42,
      }),
      expect.anything()
    )
    expect(scene.getTimelineTurns).toHaveBeenCalledWith(42)
  })

  it.each(["missing", "agent", "selectors", "disconnected", "tab", "retarget"])(
    "rejects a stale submit after a %s change",
    (change) => {
      renderTab()
      enterQuestion()
      if (change === "missing") scene.connections["tab-1"] = undefined
      if (change === "agent")
        scene.connections["tab-1"] = connection({ agentType: "claude_code" })
      if (change === "selectors")
        scene.connections["tab-1"] = connection({ selectorsReady: false })
      if (change === "disconnected")
        scene.connections["tab-1"] = connection({ status: "disconnected" })
      if (change === "tab") scene.activeTabId = "tab-2"
      if (change === "retarget")
        scene.tabs[0] = { ...scene.tabs[0], agentType: "claude_code" }
      fireEvent.click(screen.getByRole("button", { name: "Ask" }))
      expect(scene.call).not.toHaveBeenCalled()
    }
  )

  it("uses the shared editor submit intent without creating another sending path", async () => {
    renderTab()
    enterQuestion()
    expect(scene.call).not.toHaveBeenCalled()
    act(() => scene.editorSubmit?.())
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
    expect(screen.getByText("Chosen passage")).toBeInTheDocument()
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

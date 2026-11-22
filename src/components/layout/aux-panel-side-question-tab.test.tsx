import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { ConnectionState } from "@/contexts/acp-connections-context"
import type { TabItem } from "@/contexts/tab-context"
import type { NativeSideQuestion } from "@/lib/native-session"

const scene = vi.hoisted(() => {
  const state = {
    isOpen: true,
    activeTab: "side_question",
    activeTabId: "tab-1",
    tabs: [] as TabItem[],
    connection: undefined as Partial<ConnectionState> | undefined,
    call: vi.fn(),
    toastError: vi.fn(),
    store: {
      getConnection: () => state.connection,
      subscribeKey: () => () => {},
    },
  }
  return state
})

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
  useTabStore: Object.assign(
    (select: (state: typeof scene) => unknown) => select(scene),
    { getState: () => scene }
  ),
}))

vi.mock("@/contexts/acp-connections-context", () => ({
  useOptionalConnectionStore: () => scene.store,
}))

vi.mock("sonner", () => ({
  toast: { error: scene.toastError },
}))

vi.mock("@/components/terminal/terminal-view", () => ({
  TerminalView: (props: {
    terminalId: string
    workingDir: string
    isActive: boolean
    isVisible: boolean
    attach?: boolean
  }) => (
    <div
      data-testid="side-terminal"
      data-terminal-id={props.terminalId}
      data-working-dir={props.workingDir}
      data-active={String(props.isActive)}
      data-visible={String(props.isVisible)}
      data-attach={String(props.attach)}
    />
  ),
}))

import { SideQuestionTab } from "./aux-panel-side-question-tab"

const source = {
  sourceConnectionId: "conn-1",
  sourceConversationId: 7,
  sourceAgentType: "codex",
}

function side(
  id: string,
  overrides: Partial<NativeSideQuestion> = {}
): NativeSideQuestion {
  return {
    id,
    sourceSessionId: "session-1",
    branchSessionId: `branch-${id}`,
    agentType: "codex",
    cwd: "/repo",
    title: id,
    isOpen: true,
    ...overrides,
  }
}

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SideQuestionTab />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  scene.isOpen = true
  scene.activeTab = "side_question"
  scene.activeTabId = "tab-1"
  scene.connection = { connectionId: "conn-1", agentType: "codex" }
  scene.tabs = [
    {
      id: "tab-1",
      conversationId: 7,
      agentType: "codex",
      title: "Main",
      folderId: 1,
    } as TabItem,
  ]
  scene.call.mockReset()
  scene.toastError.mockReset()
})

describe("SideQuestionTab native side questions", () => {
  it("restores unclosed side questions after a restart", async () => {
    scene.call.mockImplementation((command: string) => {
      if (command === "native_session_list")
        return Promise.resolve([
          side("alpha"),
          side("closed", { isOpen: false }),
        ])
      if (command === "native_session_open_side")
        return Promise.resolve({ terminalId: "pty-alpha" })
      return Promise.resolve(undefined)
    })

    renderTab()

    expect(await screen.findByRole("button", { name: "alpha" })).toBeDefined()
    expect(screen.getByRole("button", { name: "closed" })).toBeDefined()
    await waitFor(() => {
      expect(screen.getByTestId("side-terminal").dataset.terminalId).toBe(
        "pty-alpha"
      )
    })
    expect(scene.call).toHaveBeenCalledWith("native_session_list", source)
    expect(scene.call).toHaveBeenCalledWith("native_session_open_side", {
      sideQuestionId: "alpha",
    })
    expect(scene.call).not.toHaveBeenCalledWith("native_session_open_side", {
      sideQuestionId: "closed",
    })
  })

  it("creates an independent side question and shows its own terminal", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    scene.call.mockImplementation((command: string) => {
      if (command === "native_session_list") return Promise.resolve([])
      if (command === "native_session_create_side")
        return Promise.resolve({
          sideQuestion: side("beta"),
          terminalId: "pty-beta",
        })
      return Promise.resolve(undefined)
    })

    renderTab()
    await user.click(screen.getByRole("button", { name: "New side question" }))

    await waitFor(() => {
      expect(screen.getByTestId("side-terminal").dataset.terminalId).toBe(
        "pty-beta"
      )
    })
    expect(screen.getByRole("button", { name: "beta" })).toBeDefined()
    expect(scene.call).toHaveBeenCalledWith(
      "native_session_create_side",
      { ...source, requestId: expect.any(String), title: expect.any(String) },
      expect.any(Object)
    )
  })

  it("retries a lost response with the same id but gives a new side question a new id", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const attempts: string[] = []
    scene.call.mockImplementation((command, args) => {
      if (command === "native_session_list") return Promise.resolve([])
      attempts.push(args.requestId)
      if (attempts.length === 1) return Promise.reject(new Error("offline"))
      return Promise.resolve({ sideQuestion: side(args.requestId), terminalId: `pty-${args.requestId}` })
    })
    renderTab()
    const create = screen.getByRole("button", { name: "New side question" })
    await user.click(create)
    await user.click(create)
    await user.click(create)
    expect(attempts).toHaveLength(3)
    expect(attempts[0]).toEqual(expect.any(String))
    expect(attempts[1]).toBe(attempts[0])
    expect(attempts[2]).not.toBe(attempts[1])
  })

  it("switches between side questions by attaching to each terminal", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    scene.call.mockImplementation((command: string, args: unknown) => {
      if (command === "native_session_list")
        return Promise.resolve([side("alpha"), side("beta")])
      if (command === "native_session_open_side") {
        const { sideQuestionId } = args as { sideQuestionId: string }
        return Promise.resolve({ terminalId: `pty-${sideQuestionId}` })
      }
      return Promise.resolve(undefined)
    })

    renderTab()
    await waitFor(() => {
      expect(screen.getByTestId("side-terminal").dataset.terminalId).toBe(
        "pty-alpha"
      )
    })

    await user.click(screen.getByRole("button", { name: "beta" }))

    await waitFor(() => {
      expect(screen.getByTestId("side-terminal").dataset.terminalId).toBe(
        "pty-beta"
      )
    })
    expect(scene.call).toHaveBeenCalledWith("native_session_open_side", {
      sideQuestionId: "beta",
    })
  })

  it("closes a side question but keeps it in history and can reopen it", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    scene.call.mockImplementation((command: string, args: unknown) => {
      if (command === "native_session_list")
        return Promise.resolve([side("alpha")])
      if (command === "native_session_open_side") {
        const { sideQuestionId } = args as { sideQuestionId: string }
        return Promise.resolve({ terminalId: `pty-${sideQuestionId}` })
      }
      return Promise.resolve(undefined)
    })

    renderTab()
    await waitFor(() => {
      expect(screen.getByTestId("side-terminal").dataset.terminalId).toBe(
        "pty-alpha"
      )
    })

    const item = screen.getByRole("button", { name: "alpha" }).parentElement!
    await user.click(within(item).getByRole("button", { name: "Close" }))

    await waitFor(() => {
      expect(scene.call).toHaveBeenCalledWith("native_session_close_side", {
        sideQuestionId: "alpha",
      })
    })
    // 历史项仍存在，只是标记为已关闭，不再挂载终端。
    expect(screen.getByRole("button", { name: "alpha" })).toBeDefined()
    expect(screen.getByText("Closed")).toBeDefined()
    expect(screen.queryByTestId("side-terminal")).toBeNull()

    await user.click(screen.getByRole("button", { name: "alpha" }))
    await waitFor(() => {
      expect(screen.getByTestId("side-terminal").dataset.terminalId).toBe(
        "pty-alpha"
      )
    })
  })

  it("closes a persisted side question even when its terminal could not restore", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    scene.call.mockImplementation((command: string) => {
      if (command === "native_session_list")
        return Promise.resolve([side("alpha")])
      if (command === "native_session_open_side")
        return Promise.reject(new Error("terminal unavailable"))
      return Promise.resolve(undefined)
    })

    renderTab()
    const item = (await screen.findByRole("button", { name: "alpha" }))
      .parentElement!
    await user.click(within(item).getByRole("button", { name: "Close" }))

    await waitFor(() => {
      expect(scene.call).toHaveBeenCalledWith("native_session_close_side", {
        sideQuestionId: "alpha",
      })
    })
    expect(screen.getByText("Closed")).toBeDefined()
  })

  it("keeps the side question open when the close request fails", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    scene.call.mockImplementation((command: string) => {
      if (command === "native_session_list")
        return Promise.resolve([side("alpha")])
      if (command === "native_session_open_side")
        return Promise.resolve({ terminalId: "pty-alpha" })
      if (command === "native_session_close_side")
        return Promise.reject(new Error("close failed"))
      return Promise.resolve(undefined)
    })

    renderTab()
    await screen.findByTestId("side-terminal")
    const item = screen.getByRole("button", { name: "alpha" }).parentElement!
    await user.click(within(item).getByRole("button", { name: "Close" }))

    await waitFor(() => expect(scene.toastError).toHaveBeenCalled())
    expect(screen.getByText("Open")).toBeDefined()
    expect(screen.getByTestId("side-terminal")).toBeDefined()
  })

  it("shows why creating a side question is unavailable", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    scene.call.mockImplementation((command: string) => {
      if (command === "native_session_list") return Promise.resolve([])
      return Promise.reject({
        code: "dependency_missing",
        message: "Read-only terminal is unavailable",
      })
    })

    renderTab()
    await user.click(screen.getByRole("button", { name: "New side question" }))

    await waitFor(() =>
      expect(scene.toastError).toHaveBeenCalledWith(expect.any(String), {
        description: "Read-only terminal is unavailable",
      })
    )
  })

  it("does not invent state when the source connection is missing", async () => {
    scene.connection = undefined
    scene.call.mockResolvedValue([])
    renderTab()

    expect(
      await screen.findByText(/Connect the current conversation first/)
    ).toBeDefined()
    expect(
      screen.queryByRole("button", { name: "New side question" })
    ).toBeDisabled()
  })

  it("keeps a side question available while the main conversation uses its native terminal", async () => {
    scene.call.mockImplementation((command: string) => {
      if (command === "native_session_list")
        return Promise.resolve([side("alpha")])
      if (command === "native_session_open_side")
        return Promise.resolve({ terminalId: "pty-alpha" })
      return Promise.resolve(undefined)
    })

    const { rerender } = renderTab()
    await screen.findByTestId("side-terminal")

    scene.connection = undefined
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SideQuestionTab />
      </NextIntlClientProvider>
    )

    await waitFor(() => {
      expect(scene.call).toHaveBeenCalledWith("native_session_list", {
        sourceConnectionId: "",
        sourceConversationId: 7,
        sourceAgentType: "codex",
      })
      expect(screen.getByTestId("side-terminal").dataset.terminalId).toBe(
        "pty-alpha"
      )
    })
    expect(
      screen.getByRole("button", { name: "New side question" })
    ).toBeDisabled()
  })

  it("does not show the previous session's side question after switching to an unsupported agent", async () => {
    scene.call.mockImplementation((command: string) => {
      if (command === "native_session_list")
        return Promise.resolve([side("alpha")])
      if (command === "native_session_open_side")
        return Promise.resolve({ terminalId: "pty-alpha" })
      return Promise.resolve(undefined)
    })

    const { rerender } = renderTab()
    await screen.findByTestId("side-terminal")

    scene.activeTabId = "tab-2"
    scene.tabs = [
      {
        id: "tab-2",
        conversationId: 8,
        agentType: "gemini",
        title: "Other",
        folderId: 1,
      } as TabItem,
    ]
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SideQuestionTab />
      </NextIntlClientProvider>
    )

    expect(screen.queryByRole("button", { name: "alpha" })).toBeNull()
    expect(screen.queryByTestId("side-terminal")).toBeNull()
  })

  it("does not display a late creation result in a different main session", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    let finishCreation!: (result: {
      sideQuestion: NativeSideQuestion
      terminalId: string
    }) => void
    scene.call.mockImplementation((command: string) => {
      if (command === "native_session_list") return Promise.resolve([])
      if (command === "native_session_create_side")
        return new Promise((resolve) => {
          finishCreation = resolve
        })
      return Promise.resolve(undefined)
    })

    const { rerender } = renderTab()
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "New side question" })
      ).toBeEnabled()
    )
    await user.click(screen.getByRole("button", { name: "New side question" }))

    scene.activeTabId = "tab-2"
    scene.connection = { connectionId: "conn-2", agentType: "codex" }
    scene.tabs = [
      {
        id: "tab-2",
        conversationId: 8,
        agentType: "codex",
        title: "Other",
        folderId: 1,
      } as TabItem,
    ]
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SideQuestionTab />
      </NextIntlClientProvider>
    )
    await waitFor(() =>
      expect(scene.call).toHaveBeenCalledWith("native_session_list", {
        sourceConnectionId: "conn-2",
        sourceConversationId: 8,
        sourceAgentType: "codex",
      })
    )

    await act(async () => {
      finishCreation({ sideQuestion: side("late"), terminalId: "pty-late" })
    })
    expect(screen.queryByRole("button", { name: "late" })).toBeNull()
    expect(screen.queryByTestId("side-terminal")).toBeNull()
  })
})

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { ConnectionState } from "@/contexts/acp-connections-context"

const scene = vi.hoisted(() => {
  const state = {
    connection: undefined as Partial<ConnectionState> | undefined,
    call: vi.fn(),
    attach: vi.fn(),
    toastError: vi.fn(),
  }
  return state
})

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: scene.call }),
}))

vi.mock("@/contexts/acp-connections-context", () => ({
  useOptionalConnectionStore: () => ({
    getConnection: () => scene.connection,
    subscribeKey: () => () => {},
  }),
  useAcpActions: () => ({
    attachToConnection: scene.attach,
  }),
}))

vi.mock("sonner", () => ({
  toast: { error: scene.toastError },
}))

vi.mock("./conversation-detail-header", () => ({
  ConversationDetailHeader: (props: {
    nativeViewActive?: boolean
    nativeViewAvailable?: boolean
    nativeViewBusy?: boolean
    onNativeViewChange?: (active: boolean) => void
  }) => (
    <div>
      <output data-testid="active">{String(props.nativeViewActive)}</output>
      <output data-testid="available">
        {String(props.nativeViewAvailable)}
      </output>
      <output data-testid="busy">{String(props.nativeViewBusy)}</output>
      <button onClick={() => props.onNativeViewChange?.(true)}>
        to-native
      </button>
      <button onClick={() => props.onNativeViewChange?.(false)}>to-acp</button>
    </div>
  ),
}))

vi.mock("@/components/terminal/terminal-view", () => ({
  TerminalView: (props: {
    terminalId: string
    workingDir: string
    isActive: boolean
    isVisible: boolean
    attach?: boolean
    spawnOnMissing?: boolean
  }) => (
    <div
      data-testid="terminal"
      data-terminal-id={props.terminalId}
      data-working-dir={props.workingDir}
      data-active={String(props.isActive)}
      data-visible={String(props.isVisible)}
      data-attach={String(props.attach)}
      data-spawn-on-missing={String(props.spawnOnMissing)}
    />
  ),
}))

import {
  NativeAttachedTerminal,
  NativeSessionHeader,
} from "./native-session-views"

const source = {
  sourceConnectionId: "conn-1",
  sourceConversationId: 7,
  sourceAgentType: "codex" as const,
}

function renderHeader(
  nativeTerminal: {
    terminalId: string
    sourceConnectionId: string
  } | null = null
) {
  const onNativeTerminalChange = vi.fn()
  const view = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <NativeSessionHeader
        tabId="tab-1"
        conversationId={7}
        runtimeConversationId={null}
        folderId={1}
        folderPath="/repo"
        title="Main"
        status="in_progress"
        agentType="codex"
        nativeTerminal={nativeTerminal}
        onNativeTerminalChange={onNativeTerminalChange}
      />
    </NextIntlClientProvider>
  )
  return { ...view, onNativeTerminalChange }
}

beforeEach(() => {
  scene.connection = {
    connectionId: "conn-1",
    agentType: "codex",
    status: "connected",
  }
  scene.call.mockReset()
  scene.attach.mockReset()
  scene.attach.mockResolvedValue(true)
  scene.toastError.mockReset()
})

describe("NativeSessionHeader", () => {
  it("opens the main native session with the source identity", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    scene.call.mockResolvedValue({ terminalId: "pty-main" })
    const { onNativeTerminalChange } = renderHeader()

    await user.click(screen.getByRole("button", { name: "to-native" }))

    await waitFor(() =>
      expect(onNativeTerminalChange).toHaveBeenCalledWith({
        terminalId: "pty-main",
        sourceConnectionId: "conn-1",
      })
    )
    expect(scene.call).toHaveBeenCalledWith("native_session_open_main", source)
  })

  it("closes the main terminal before returning to ACP chat", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    scene.call.mockResolvedValue({ connectionId: "conn-2" })
    const { onNativeTerminalChange } = renderHeader({
      terminalId: "pty-main",
      sourceConnectionId: "conn-1",
    })

    expect(screen.getByTestId("active").textContent).toBe("true")
    await user.click(screen.getByRole("button", { name: "to-acp" }))

    expect(onNativeTerminalChange).toHaveBeenCalledWith(null, "conn-2")
    expect(scene.call).toHaveBeenCalledWith("native_session_close_main", {
      sourceConnectionId: "conn-1",
      terminalId: "pty-main",
    })
  })

  it("waits for the native terminal to release the session before showing ACP", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    let finishClose!: () => void
    scene.call.mockImplementation(
      () =>
        new Promise<{ connectionId: string }>((resolve) => {
          finishClose = () => resolve({ connectionId: "conn-2" })
        })
    )
    const { onNativeTerminalChange } = renderHeader({
      terminalId: "pty-main",
      sourceConnectionId: "conn-1",
    })

    await user.click(screen.getByRole("button", { name: "to-acp" }))

    expect(onNativeTerminalChange).not.toHaveBeenCalled()
    finishClose()
    await waitFor(() =>
      expect(onNativeTerminalChange).toHaveBeenCalledWith(null, "conn-2")
    )
  })

  it("re-attaches the restored connection as owner before returning to ACP", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    scene.call.mockResolvedValue({ connectionId: "conn-2", reused: false })
    // 被动 attach 完成前不能切回 ACP，否则自动重连会先看到旧连接。
    let finishAttach!: () => void
    scene.attach.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishAttach = () => resolve(true)
        })
    )
    const { onNativeTerminalChange } = renderHeader({
      terminalId: "pty-main",
      sourceConnectionId: "conn-1",
    })

    await user.click(screen.getByRole("button", { name: "to-acp" }))

    expect(scene.attach).toHaveBeenCalledWith(
      "tab-1",
      "conn-2",
      "codex",
      "/repo",
      { isViewer: false }
    )
    expect(onNativeTerminalChange).not.toHaveBeenCalled()
    finishAttach()
    await waitFor(() =>
      expect(onNativeTerminalChange).toHaveBeenCalledWith(null, "conn-2")
    )
  })

  it("re-attaches as viewer when the backend reused an existing connection", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    scene.call.mockResolvedValue({ connectionId: "conn-2", reused: true })
    renderHeader({
      terminalId: "pty-main",
      sourceConnectionId: "conn-1",
    })

    await user.click(screen.getByRole("button", { name: "to-acp" }))

    await waitFor(() =>
      expect(scene.attach).toHaveBeenCalledWith(
        "tab-1",
        "conn-2",
        "codex",
        "/repo",
        { isViewer: true }
      )
    )
  })

  it("returns to ACP even when the passive attach fails", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    scene.call.mockResolvedValue({ connectionId: "conn-2" })
    scene.attach.mockRejectedValue(new Error("restored connection is gone"))
    const { onNativeTerminalChange } = renderHeader({
      terminalId: "pty-main",
      sourceConnectionId: "conn-1",
    })

    await user.click(screen.getByRole("button", { name: "to-acp" }))

    await waitFor(() =>
      expect(onNativeTerminalChange).toHaveBeenCalledWith(null, "conn-2")
    )
  })

  it("keeps the native terminal visible when returning to ACP fails", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    scene.call.mockRejectedValue(new Error("session still in use"))
    const { onNativeTerminalChange } = renderHeader({
      terminalId: "pty-main",
      sourceConnectionId: "conn-1",
    })

    await user.click(screen.getByRole("button", { name: "to-acp" }))

    await waitFor(() => expect(scene.toastError).toHaveBeenCalled())
    expect(onNativeTerminalChange).not.toHaveBeenCalled()
  })

  it("returns to ACP after the source connection has disappeared", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    scene.connection = undefined
    scene.call.mockResolvedValue({ connectionId: "conn-2" })
    const { onNativeTerminalChange } = renderHeader({
      terminalId: "pty-main",
      sourceConnectionId: "conn-1",
    })

    // 句柄仍在，所以即使 ACP 条目已被后端移除，也必须允许切回。
    expect(screen.getByTestId("available").textContent).toBe("true")
    await user.click(screen.getByRole("button", { name: "to-acp" }))

    expect(scene.call).toHaveBeenCalledWith("native_session_close_main", {
      sourceConnectionId: "conn-1",
      terminalId: "pty-main",
    })
    expect(onNativeTerminalChange).toHaveBeenCalledWith(null, "conn-2")
  })

  it("does not stay busy on a stale prompting connection while native", () => {
    scene.connection = {
      connectionId: "conn-1",
      agentType: "codex",
      status: "prompting",
    }
    renderHeader({
      terminalId: "pty-main",
      sourceConnectionId: "conn-1",
    })

    expect(screen.getByTestId("busy").textContent).toBe("false")
  })

  it("waits while the main turn is running", () => {
    scene.connection = {
      connectionId: "conn-1",
      agentType: "codex",
      status: "prompting",
    }
    renderHeader()

    expect(screen.getByTestId("busy").textContent).toBe("true")
  })

  it("keeps ACP active when the main terminal cannot be opened", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    scene.call.mockRejectedValue(new Error("not ready"))
    const { onNativeTerminalChange } = renderHeader()

    await user.click(screen.getByRole("button", { name: "to-native" }))

    await waitFor(() => expect(scene.toastError).toHaveBeenCalled())
    expect(onNativeTerminalChange).not.toHaveBeenCalled()
  })

  it("is unavailable without a live source connection or native handle", () => {
    scene.connection = undefined
    renderHeader()

    expect(screen.getByTestId("available").textContent).toBe("false")
  })
})

describe("NativeAttachedTerminal", () => {
  it("attaches to the existing PTY and follows the view state", () => {
    const { rerender } = render(
      <NativeAttachedTerminal
        terminalId="pty-1"
        workingDir="/repo"
        isActive={false}
        isVisible={false}
      />
    )

    const terminal = screen.getByTestId("terminal")
    expect(terminal.dataset.terminalId).toBe("pty-1")
    expect(terminal.dataset.workingDir).toBe("/repo")
    expect(terminal.dataset.active).toBe("false")
    expect(terminal.dataset.visible).toBe("false")
    expect(terminal.dataset.attach).toBe("true")
    expect(terminal.dataset.spawnOnMissing).toBe("false")

    rerender(
      <NativeAttachedTerminal
        terminalId="pty-2"
        workingDir="/repo"
        isActive
        isVisible
      />
    )

    const next = screen.getByTestId("terminal")
    expect(next).not.toBe(terminal)
    expect(next.dataset.terminalId).toBe("pty-2")
    expect(next.dataset.active).toBe("true")
    expect(next.dataset.visible).toBe("true")
  })
})

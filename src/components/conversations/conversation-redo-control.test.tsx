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
import { afterEach, expect, it, vi } from "vitest"

import messages from "@/i18n/messages/zh-CN.json"
import { ConversationRedoControl } from "./conversation-redo-control"

const notices = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: notices }))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

it("reports restored history even when the agent cannot reconnect afterward", async () => {
  const user = userEvent.setup()
  let restored = false
  render(
    <NextIntlClientProvider locale="zh-CN" messages={messages}>
      <ConversationRedoControl
        conversationId={12}
        revision={0}
        busy={false}
        onRestored={async () => {
          throw new Error("Cline SDK is not installed in this isolated runtime")
        }}
        backend={{
          status: async () => ({
            available: !restored,
            hasBackup: !restored,
            expiresAt: "2026-11-24T00:00:00Z",
          }),
          restore: async () => {
            restored = true
            return { conversationId: 12, sessionId: "same-session" }
          },
          clear: async () => {},
        }}
      />
    </NextIntlClientProvider>
  )
  await user.click(await screen.findByRole("button", { name: "恢复上次撤回" }))
  await waitFor(() => {
    expect(
      screen.queryByRole("button", { name: "恢复上次撤回" })
    ).not.toBeInTheDocument()
  })
  expect(restored).toBe(true)
  expect(notices.success).toHaveBeenCalledWith(
    messages.ConversationUndo.redoDone
  )
  expect(notices.info).toHaveBeenCalledWith(
    messages.ConversationUndo.redoReconnectFailed
  )
  expect(notices.error).not.toHaveBeenCalled()
})

it("still reports an actual native restore failure and leaves Redo available", async () => {
  const user = userEvent.setup()
  const onRestored = vi.fn()
  render(
    <NextIntlClientProvider locale="zh-CN" messages={messages}>
      <ConversationRedoControl
        conversationId={12}
        revision={0}
        busy={false}
        onRestored={onRestored}
        backend={{
          status: async () => ({
            available: true,
            hasBackup: true,
            expiresAt: "2026-11-24T00:00:00Z",
          }),
          restore: async () => {
            throw new Error("native history changed")
          },
          clear: async () => {},
        }}
      />
    </NextIntlClientProvider>
  )
  await user.click(await screen.findByRole("button", { name: "恢复上次撤回" }))
  await waitFor(() => {
    expect(notices.error).toHaveBeenCalledWith(
      messages.ConversationUndo.redoFailed,
      { description: "native history changed" }
    )
  })
  expect(screen.getByRole("button", { name: "恢复上次撤回" })).toBeEnabled()
  expect(onRestored).not.toHaveBeenCalled()
  expect(notices.success).not.toHaveBeenCalled()
  expect(notices.info).not.toHaveBeenCalled()
})

it("clears a session's Redo backup only after explicit confirmation", async () => {
  const user = userEvent.setup()
  const wire = { available: true, hasBackup: true }
  render(
    <NextIntlClientProvider locale="zh-CN" messages={messages}>
      <ConversationRedoControl
        conversationId={12}
        revision={0}
        busy={false}
        onRestored={async () => {}}
        backend={{
          status: async () => ({
            available: wire.available,
            hasBackup: wire.hasBackup,
            expiresAt: "2026-11-24T00:00:00Z",
          }),
          restore: async () => ({
            conversationId: 12,
            sessionId: "same-session",
          }),
          clear: async () => {
            wire.hasBackup = false
            wire.available = false
          },
        }}
      />
    </NextIntlClientProvider>
  )
  expect(
    screen.queryByRole("button", { name: "清理撤回备份" })
  ).not.toBeInTheDocument()
  await user.click(await screen.findByRole("button", { name: "撤回选项" }))
  await user.click(screen.getByRole("menuitem", { name: "清理撤回备份" }))
  const confirmation = screen.getByRole("alertdialog")
  expect(confirmation).toHaveTextContent("当前对话、草稿和收藏不受影响")
  expect(wire.hasBackup).toBe(true)
  await user.click(
    within(confirmation).getByRole("button", { name: "清理撤回备份" })
  )
  await waitFor(() => {
    expect(
      screen.queryByRole("button", { name: "恢复上次撤回" })
    ).not.toBeInTheDocument()
  })
  expect(wire.hasBackup).toBe(false)
})

it("refreshes and removes expired Redo without requiring a page reload", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-11-17T00:00:00Z"))
  const expiration = Date.parse("2026-11-24T00:00:00Z")
  render(
    <NextIntlClientProvider locale="zh-CN" messages={messages}>
      <ConversationRedoControl
        conversationId={12}
        revision={0}
        busy={false}
        onRestored={async () => {}}
        backend={{
          status: async () => ({
            available: Date.now() < expiration,
            hasBackup: Date.now() < expiration,
            expiresAt: "2026-11-24T00:00:00Z",
          }),
          restore: async () => ({
            conversationId: 12,
            sessionId: "same-session",
          }),
          clear: async () => {},
        }}
      />
    </NextIntlClientProvider>
  )
  await act(async () => {})
  expect(screen.getByRole("button", { name: "恢复上次撤回" })).toBeEnabled()
  await act(() => vi.advanceTimersByTimeAsync(7 * 86400 * 1000 + 1000))
  expect(
    screen.queryByRole("button", { name: "恢复上次撤回" })
  ).not.toBeInTheDocument()
})

it("disables stale Redo immediately when a new message changes the history", async () => {
  let finishRead: (value: {
    available: boolean
    hasBackup: boolean
    expiresAt: string
  }) => void = () => {}
  let changed = false
  const backend = {
    status: async () => {
      if (!changed)
        return {
          available: true,
          hasBackup: true,
          expiresAt: "2026-11-24T00:00:00Z",
        }
      return new Promise<{
        available: boolean
        hasBackup: boolean
        expiresAt: string
      }>((resolve) => {
        finishRead = resolve
      })
    },
    restore: async () => ({
      conversationId: 12,
      sessionId: "same-session",
    }),
    clear: async () => {},
  }
  const view = (revision: number) => (
    <NextIntlClientProvider locale="zh-CN" messages={messages}>
      <ConversationRedoControl
        conversationId={12}
        revision={revision}
        busy={false}
        onRestored={async () => {}}
        backend={backend}
      />
    </NextIntlClientProvider>
  )
  const { rerender } = render(view(0))
  expect(
    await screen.findByRole("button", { name: "恢复上次撤回" })
  ).toBeEnabled()
  changed = true
  rerender(view(1))
  expect(screen.getByRole("button", { name: "恢复上次撤回" })).toBeDisabled()
  await act(async () => {
    finishRead({
      available: false,
      hasBackup: true,
      expiresAt: "2026-11-24T00:00:00Z",
    })
  })
  expect(
    screen.queryByRole("button", { name: "恢复上次撤回" })
  ).not.toBeInTheDocument()
  // 不可恢复时只剩“更多”，用来清理已经失效的备份。
  expect(screen.getByRole("button", { name: "撤回选项" })).toBeEnabled()
})

it("shows a compact recovery action instead of two full-width text actions", async () => {
  render(
    <NextIntlClientProvider locale="zh-CN" messages={messages}>
      <ConversationRedoControl
        conversationId={12}
        revision={0}
        busy={false}
        onRestored={async () => {}}
        backend={{
          status: async () => ({
            available: true,
            hasBackup: true,
            expiresAt: "2026-11-24T00:00:00Z",
          }),
          restore: async () => ({
            conversationId: 12,
            sessionId: "same-session",
          }),
          clear: async () => {},
        }}
      />
    </NextIntlClientProvider>
  )
  const restore = await screen.findByRole("button", { name: "恢复上次撤回" })
  expect(restore).toHaveTextContent(/^恢复$/)
  // 行内只有恢复和更多两个操作，不再重复状态说明。
  expect(restore.parentElement).toHaveTextContent(/^恢复$/)
  expect(screen.getByRole("button", { name: "撤回选项" })).toBeEnabled()
  expect(
    screen.queryByRole("button", { name: "清理撤回备份" })
  ).not.toBeInTheDocument()
})

it("renders no recovery row at all when this conversation was never undone", async () => {
  render(
    <NextIntlClientProvider locale="zh-CN" messages={messages}>
      <ConversationRedoControl
        conversationId={12}
        revision={0}
        busy={false}
        onRestored={async () => {}}
        backend={{
          status: async () => ({
            available: false,
            hasBackup: false,
            expiresAt: null,
          }),
          restore: async () => ({
            conversationId: 12,
            sessionId: "same-session",
          }),
          clear: async () => {},
        }}
      />
    </NextIntlClientProvider>
  )
  // 未撤回过的会话不能留下常驻按钮：恢复与更多都不应出现。
  await act(async () => {})
  expect(
    screen.queryByRole("button", { name: "恢复上次撤回" })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole("button", { name: "撤回选项" })
  ).not.toBeInTheDocument()
})

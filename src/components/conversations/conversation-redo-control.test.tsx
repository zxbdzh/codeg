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

afterEach(() => {
  cleanup()
  vi.useRealTimers()
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
  await user.click(await screen.findByRole("button", { name: "清理撤回备份" }))
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
  expect(screen.getByRole("button", { name: "恢复上次撤回" })).toBeDisabled()
})

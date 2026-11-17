import { cleanup, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, expect, it } from "vitest"

import messages from "@/i18n/messages/zh-CN.json"
import { ConversationUndoDialog } from "./conversation-undo-dialog"

afterEach(cleanup)

it("shows the confirmed starting message and affected range before Undo", () => {
  render(
    <NextIntlClientProvider locale="zh-CN" messages={messages}>
      <ConversationUndoDialog
        open
        pending={false}
        onCancel={() => {}}
        onConfirm={() => {}}
        preview={{
          conversationId: 12,
          sessionId: "same-session",
          sourceTurnId: "turn-2",
          historyRevision: "history-before-confirmation",
          affectedTurns: 4,
          affectedUserMessages: 2,
          prompt: {
            id: "turn-2",
            role: "user",
            timestamp: "2026-11-17T00:00:00Z",
            blocks: [{ type: "text", text: "从这条消息开始撤回" }],
          },
        }}
      />
    </NextIntlClientProvider>
  )
  expect(screen.getByRole("alertdialog")).toHaveTextContent(
    "从这条消息开始撤回"
  )
  expect(screen.getByText("将撤回 2 条用户消息，共 4 条对话记录")).toBeVisible()
  expect(screen.getByRole("alertdialog")).toHaveTextContent("不会恢复")
})

it("lists unavailable original attachments and prevents confirming a partial refill", () => {
  render(
    <NextIntlClientProvider locale="zh-CN" messages={messages}>
      <ConversationUndoDialog
        open
        pending={false}
        onCancel={() => {}}
        onConfirm={() => {}}
        preview={{
          conversationId: 12,
          sessionId: "same-session",
          sourceTurnId: "turn-2",
          historyRevision: "history-before-confirmation",
          affectedTurns: 2,
          affectedUserMessages: 1,
          prompt: {
            id: "turn-2",
            role: "user",
            timestamp: "2026-11-17T00:00:00Z",
            blocks: [{ type: "text", text: "查看附件" }],
          },
          issues: [{ code: "missing_original_attachment", label: "lost.png" }],
        }}
      />
    </NextIntlClientProvider>
  )
  expect(screen.getByRole("alert")).toHaveTextContent("lost.png")
  expect(screen.getByRole("button", { name: "确认撤回" })).toBeDisabled()
})

it("lists current, background and delegated work before confirming stop and Undo", () => {
  render(
    <NextIntlClientProvider locale="zh-CN" messages={messages}>
      <ConversationUndoDialog
        open
        pending={false}
        onCancel={() => {}}
        onConfirm={() => {}}
        preview={{
          conversationId: 12,
          sessionId: "same-session",
          sourceTurnId: "turn-2",
          historyRevision: "history-before-confirmation",
          affectedTurns: 2,
          affectedUserMessages: 1,
          prompt: {
            id: "turn-2",
            role: "user",
            timestamp: "2026-11-17T00:00:00Z",
            blocks: [{ type: "text", text: "正在处理的问题" }],
          },
          tasks: [
            { id: "current", kind: "turn", label: "当前生成任务" },
            { id: "build", kind: "background", label: "后台构建" },
            { id: "delegate", kind: "delegation", label: "委托审查" },
          ],
        }}
      />
    </NextIntlClientProvider>
  )
  expect(screen.getByText("当前生成任务")).toBeVisible()
  expect(screen.getByText("后台构建")).toBeVisible()
  expect(screen.getByText("委托审查")).toBeVisible()
  expect(screen.getByRole("button", { name: "停止并撤回" })).toBeEnabled()
})

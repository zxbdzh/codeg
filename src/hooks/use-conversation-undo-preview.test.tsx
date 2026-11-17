import { act, render, renderHook, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { Toaster } from "sonner"
import { expect, it } from "vitest"

import messages from "@/i18n/messages/zh-CN.json"
import type { MessageTurn, PromptStashSnapshot } from "@/lib/types"
import { useConversationUndo } from "./use-conversation-undo"

it("opens confirmation with the backend's exact range and original image", async () => {
  const preview = {
    conversationId: 12,
    sessionId: "same-session",
    sourceTurnId: "turn-2",
    historyRevision: "confirmed-history",
    affectedTurns: 2,
    affectedUserMessages: 1,
    prompt: {
      id: "turn-2",
      role: "user" as const,
      timestamp: "2026-11-17T00:00:00Z",
      blocks: [
        { type: "text" as const, text: "查看这张原图" },
        {
          type: "image" as const,
          data: "b3JpZ2luYWw=",
          mime_type: "image/png",
        },
      ],
    },
  }
  const { result } = renderHook(
    () =>
      useConversationUndo({
        conversationId: 12,
        busy: false,
        onComplete: async () => {},
        onFailure: async () => {},
        backend: { preview: async () => preview },
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <NextIntlClientProvider locale="zh-CN" messages={messages}>
          {children}
        </NextIntlClientProvider>
      ),
    }
  )
  await act(async () => {
    await result.current.requestUndo("turn-2", "查看这张原图", false, {
      text: "查看这张原图",
      timestamp: "2026-11-17T00:00:00Z",
      agentMessageId: null,
    })
  })
  expect(result.current.selection?.preview).toEqual(preview)
  expect(result.current.pending).toBe(false)
})

it("protects the current draft and returns the original image for complete refill", async () => {
  const prompt: MessageTurn = {
    id: "turn-2",
    role: "user",
    timestamp: "2026-11-17T00:00:00Z",
    blocks: [
      { type: "text", text: "原来的问题" },
      { type: "image", data: "b3JpZ2luYWw=", mime_type: "image/png" },
    ],
  }
  const draft: PromptStashSnapshot = {
    text: "尚未发送的草稿",
    doc: { type: "doc", content: [] },
    attachments: [
      {
        id: "draft-image",
        type: "image",
        data: "ZHJhZnQ=",
        mimeType: "image/png",
        name: "draft.png",
        uri: null,
      },
    ],
    embeddedPayloads: {},
  }
  const observed: {
    sentDraft: PromptStashSnapshot | null
    restored: MessageTurn | null
  } = { sentDraft: null, restored: null }
  const { result } = renderHook(
    () =>
      useConversationUndo({
        conversationId: 12,
        busy: false,
        captureDraft: () => draft,
        onComplete: async (_result, _text, original) => {
          observed.restored = original ?? null
        },
        onFailure: async () => {},
        backend: {
          preview: async () => ({
            conversationId: 12,
            sessionId: "same-session",
            sourceTurnId: "turn-2",
            historyRevision: "confirmed-history",
            affectedTurns: 2,
            affectedUserMessages: 1,
            prompt,
          }),
          commit: async (request) => {
            observed.sentDraft = request.currentDraft
            return { conversationId: 12, sessionId: "same-session", prompt }
          },
        },
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <NextIntlClientProvider locale="zh-CN" messages={messages}>
          {children}
        </NextIntlClientProvider>
      ),
    }
  )
  await act(() =>
    result.current.requestUndo("turn-2", "原来的问题", false, {
      text: "原来的问题",
      timestamp: prompt.timestamp,
      agentMessageId: null,
    })
  )
  await act(() => result.current.confirmUndo())
  expect(observed.sentDraft?.text).toBe("尚未发送的草稿")
  expect(observed.sentDraft?.attachments[0]).toMatchObject({
    data: "ZHJhZnQ=",
    name: "draft.png",
  })
  expect(observed.restored?.blocks[1]).toMatchObject({
    type: "image",
    data: "b3JpZ2luYWw=",
  })
})

it("allows a running session to preview and explicitly confirm stopping before Undo", async () => {
  const observed = { stopConfirmed: false }
  const prompt: MessageTurn = {
    id: "turn-2",
    role: "user",
    timestamp: "2026-11-17T00:00:00Z",
    blocks: [{ type: "text", text: "撤回运行中的问题" }],
  }
  const { result } = renderHook(
    () =>
      useConversationUndo({
        conversationId: 12,
        busy: true,
        onComplete: async () => {},
        onFailure: async () => {},
        backend: {
          preview: async () => ({
            conversationId: 12,
            sessionId: "same-session",
            sourceTurnId: "turn-2",
            historyRevision: "confirmed-history",
            affectedTurns: 2,
            affectedUserMessages: 1,
            prompt,
            tasks: [
              { id: "current:turn", kind: "turn", label: "正在生成报告" },
            ],
          }),
          commit: async (request) => {
            observed.stopConfirmed = request.stopConfirmed
            return { conversationId: 12, sessionId: "same-session", prompt }
          },
        },
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <NextIntlClientProvider locale="zh-CN" messages={messages}>
          {children}
        </NextIntlClientProvider>
      ),
    }
  )
  await act(() =>
    result.current.requestUndo("turn-2", "撤回运行中的问题", false, {
      text: "撤回运行中的问题",
      timestamp: prompt.timestamp,
      agentMessageId: null,
    })
  )
  expect(result.current.selection?.preview.tasks?.[0].label).toBe(
    "正在生成报告"
  )
  await act(() => result.current.confirmUndo())
  expect(observed.stopConfirmed).toBe(true)
})

it("shows the actual conflict reason when history changes before confirmation", async () => {
  function Confirmation() {
    const undo = useConversationUndo({
      conversationId: 12,
      busy: false,
      onComplete: async () => {},
      onFailure: async () => {},
      backend: {
        preview: async () => ({
          conversationId: 12,
          sessionId: "same-session",
          sourceTurnId: "turn-2",
          historyRevision: "confirmed-history",
          affectedTurns: 2,
          affectedUserMessages: 1,
          prompt: {
            id: "turn-2",
            role: "user",
            timestamp: "2026-11-17T00:00:00Z",
            blocks: [{ type: "text", text: "原来的问题" }],
          },
        }),
        commit: async () => {
          throw {
            code: "invalid_input",
            message:
              "Conversation history changed; refresh and confirm Undo again",
            i18n_key: "historyChanged",
          }
        },
      },
    })
    return (
      <>
        <button
          onClick={() =>
            void undo.requestUndo("turn-2", "原来的问题", false, {
              text: "原来的问题",
              timestamp: "2026-11-17T00:00:00Z",
              agentMessageId: null,
            })
          }
        >
          Select message
        </button>
        {undo.selection && (
          <button onClick={() => void undo.confirmUndo()}>Confirm Undo</button>
        )}
        <Toaster />
      </>
    )
  }
  render(
    <NextIntlClientProvider locale="zh-CN" messages={messages}>
      <Confirmation />
    </NextIntlClientProvider>
  )
  await userEvent.click(screen.getByRole("button", { name: "Select message" }))
  await userEvent.click(screen.getByRole("button", { name: "Confirm Undo" }))
  expect(
    await screen.findByText(
      "会话历史已变化，已取消本次撤回并保留最新记录。请刷新后重新发起并确认。"
    )
  ).toBeVisible()
})

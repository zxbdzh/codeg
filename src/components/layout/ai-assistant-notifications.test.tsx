import { act, render, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, expect, it, vi } from "vitest"
import messages from "@/i18n/messages/en.json"

const mocks = vi.hoisted(() => ({ subscribe: vi.fn(), error: vi.fn() }))
vi.mock("@/lib/platform", () => ({ subscribe: mocks.subscribe }))
vi.mock("sonner", () => ({ toast: { error: mocks.error } }))

import { AiAssistantNotifications } from "./ai-assistant-notifications"

beforeEach(() => {
  vi.clearAllMocks()
})

it("shows an automatic title failure without treating the coding turn as failed", async () => {
  let receive: (payload: unknown) => void = () => undefined
  const unsubscribe = vi.fn()
  mocks.subscribe.mockImplementation(async (_channel, handler) => {
    receive = handler
    return unsubscribe
  })
  const view = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AiAssistantNotifications />
    </NextIntlClientProvider>
  )
  await waitFor(() => expect(mocks.subscribe).toHaveBeenCalled())

  act(() =>
    receive({
      conversationId: 7,
      error: {
        code: "authentication_failed",
        message: "provider rejected the key",
        i18n_key: "aiAssistant.errorUnauthorized",
      },
    })
  )

  expect(mocks.error).toHaveBeenCalledWith(messages.AiAssistantSettings.title, {
    id: "ai-assistant:7",
    description: messages.AiAssistant.errorUnauthorized,
  })
  view.unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
})

it("releases a subscription that finishes registering after the workspace unmounts", async () => {
  let finish: (unsubscribe: () => void) => void = () => undefined
  mocks.subscribe.mockImplementation(
    () =>
      new Promise<() => void>((resolve) => {
        finish = resolve
      })
  )
  const unsubscribe = vi.fn()
  const view = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AiAssistantNotifications />
    </NextIntlClientProvider>
  )
  view.unmount()
  await act(async () => {
    finish(unsubscribe)
  })
  expect(unsubscribe).toHaveBeenCalledOnce()
})

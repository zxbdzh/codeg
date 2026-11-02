import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { expect, it, vi } from "vitest"
import messages from "@/i18n/messages/en.json"

vi.mock("@/lib/api", () => ({
  getAiAssistantAvailability: async () => "no_provider",
  getTagSuggestionStatus: async () => ({
    batch: { id: "pending", candidates: [{ name: "MCP" }] },
    ignored: [],
    error: null,
    running: false,
  }),
}))
vi.mock("@/lib/platform", () => ({ subscribe: async () => () => {} }))
import { AiTagButton } from "./ai-conversation-actions"

it("keeps existing suggestions accessible when generation is unavailable", async () => {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AiTagButton conversationId={12} folderId={3} />
    </NextIntlClientProvider>
  )
  expect(
    await screen.findByRole("button", { name: "Tag suggestions available" })
  ).toBeEnabled()
})

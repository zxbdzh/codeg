import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, expect, it, vi } from "vitest"
import messages from "@/i18n/messages/en.json"
import userEvent from "@testing-library/user-event"

const harness = vi.hoisted(() => ({ status: vi.fn() }))
vi.mock("@/lib/api", () => ({
  getTagSuggestionStatus: harness.status,
}))
beforeEach(() => {
  harness.status.mockResolvedValue({
    batch: { id: "batch-1", candidates: [{ name: "MCP" }] },
    running: false,
    error: null,
    ignored: [],
  })
})
vi.mock("@/lib/platform", () => ({ subscribe: async () => () => {} }))
import { AiTagStatus } from "./ai-tag-status"

it("shows a pending suggestion without opening a dialog", async () => {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AiTagStatus conversationId={12} onOpen={vi.fn()} />
    </NextIntlClientProvider>
  )
  expect(
    await screen.findByRole("button", { name: "Tag suggestions available" })
  ).toBeVisible()
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
})

it("only opens suggestions when the user clicks the pending indicator", async () => {
  const user = userEvent.setup()
  const open = vi.fn()
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AiTagStatus conversationId={12} onOpen={open} />
    </NextIntlClientProvider>
  )
  const indicator = await screen.findByRole("button", {
    name: "Tag suggestions available",
  })
  expect(open).not.toHaveBeenCalled()
  await user.click(indicator)
  expect(open).toHaveBeenCalledOnce()
})

it("keeps a generation error visible beside existing suggestions", async () => {
  harness.status.mockResolvedValue({
    batch: { id: "batch-1", candidates: [{ name: "MCP" }] },
    running: false,
    error: "The model was not found",
    ignored: [],
  })
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AiTagStatus conversationId={12} onOpen={vi.fn()} />
    </NextIntlClientProvider>
  )
  expect(await screen.findByText("Tag suggestions failed")).toBeVisible()
  expect(
    screen.getByRole("button", { name: "Tag suggestions available" })
  ).toBeVisible()
})

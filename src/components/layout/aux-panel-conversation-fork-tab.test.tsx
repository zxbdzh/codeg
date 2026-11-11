import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import {
  useConversationForkStore,
  type ConversationForkTarget,
} from "@/stores/conversation-fork-store"
import { ConversationForkTab } from "./aux-panel-conversation-fork-tab"

const scene = vi.hoisted(() => ({ activeTabId: "first", detail: vi.fn() }))
vi.mock("@/contexts/tab-context", () => ({
  useTabStore: (select: (state: typeof scene) => unknown) => select(scene),
}))
vi.mock("@/lib/api", () => ({ getFolderConversation: scene.detail }))

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ConversationForkTab />
    </NextIntlClientProvider>
  )
}

function target(conversationId: number): ConversationForkTarget {
  return {
    conversationId,
    unavailable: null,
    onSelect: vi.fn().mockResolvedValue(true),
  }
}

beforeEach(() => {
  scene.activeTabId = "first"
  useConversationForkStore.setState({ byTab: {} })
  scene.detail.mockReset().mockImplementation(async (id: number) => ({
    summary: { agent_type: "codex" },
    turns: [
      {
        id: "turn-0",
        role: "user",
        timestamp: "2026-11-11T00:00:00Z",
        blocks: [{ type: "text", text: `Prompt ${id}` }],
      },
    ],
  }))
})

it("shows the active conversation's own messages directly in the sidebar", async () => {
  const first = target(1)
  const second = target(2)
  useConversationForkStore.getState().register("first", first)
  useConversationForkStore.getState().register("second", second)
  const view = renderTab()
  fireEvent.click(await screen.findByRole("button", { name: "Prompt 1" }))
  expect(first.onSelect).toHaveBeenCalledWith(
    "turn-0",
    "Prompt 1",
    true,
    expect.any(Object)
  )
  expect(second.onSelect).not.toHaveBeenCalled()
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  scene.activeTabId = "second"
  view.rerender(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ConversationForkTab />
    </NextIntlClientProvider>
  )
  expect(
    await screen.findByRole("button", { name: "Prompt 2" })
  ).toBeInTheDocument()
  expect(
    screen.queryByRole("button", { name: "Prompt 1" })
  ).not.toBeInTheDocument()
})

it("drops an unmounted target without letting old cleanup remove its replacement", async () => {
  const unregister = useConversationForkStore
    .getState()
    .register("first", target(1))
  const removeReplacement = useConversationForkStore
    .getState()
    .register("first", target(2))
  unregister()
  renderTab()
  expect(
    await screen.findByRole("button", { name: "Prompt 2" })
  ).toBeInTheDocument()
  act(removeReplacement)
  expect(
    screen.getByText(enMessages.ResearchBranch.connectionRequired)
  ).toBeInTheDocument()
  expect(
    screen.queryByRole("button", { name: "Prompt 2" })
  ).not.toBeInTheDocument()
})

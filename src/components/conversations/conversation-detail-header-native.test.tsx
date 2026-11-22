import type { ComponentProps } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

vi.mock("@/lib/api", () => ({
  deleteConversation: vi.fn(),
  updateConversationPinned: vi.fn(),
  updateConversationStatus: vi.fn(),
  updateConversationTitle: vi.fn(),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({
    closeTab: vi.fn(),
    openNewConversationTab: vi.fn(),
  }),
}))
vi.mock("@/stores/app-workspace-store", () => {
  const state = {
    updateConversationLocal: vi.fn(),
    refreshConversations: vi.fn(),
    conversations: [] as unknown[],
  }
  const useStore = (selector: (s: typeof state) => unknown) => selector(state)
  useStore.getState = () => state
  return { useAppWorkspaceStore: useStore }
})
vi.mock("@/stores/conversation-runtime-store", () => ({
  getRuntimeSession: () => null,
}))
vi.mock("./session-details-dialog", () => ({
  SessionDetailsDialog: () => null,
}))
vi.mock("@/components/chat/conversation-context-bar", () => ({
  ConversationHeaderFolderPicker: () => null,
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }))

import { ConversationDetailHeader } from "./conversation-detail-header"

type Props = ComponentProps<typeof ConversationDetailHeader>

function renderHeader(overrides: Partial<Props> = {}) {
  const onNativeViewChange = vi.fn()
  const props: Props = {
    tabId: "tab-a",
    conversationId: 1,
    runtimeConversationId: null,
    folderId: 1,
    folderPath: "/a",
    title: "conv-a",
    status: "in_progress",
    agentType: "codex",
    nativeViewActive: false,
    nativeViewAvailable: true,
    onNativeViewChange,
    ...overrides,
  }
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ConversationDetailHeader {...props} />
    </NextIntlClientProvider>
  )
  return { onNativeViewChange }
}

describe("ConversationDetailHeader native terminal switch", () => {
  it("switches the current session between ACP chat and the native terminal", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { onNativeViewChange } = renderHeader()

    await user.click(screen.getByRole("button", { name: "Native terminal" }))
    expect(onNativeViewChange).toHaveBeenLastCalledWith(true)

    await user.click(screen.getByRole("button", { name: "ACP chat" }))
    expect(onNativeViewChange).toHaveBeenLastCalledWith(false)
  })

  it("waits for the running main turn before entering the native terminal", () => {
    renderHeader({ nativeViewBusy: true })

    expect(
      screen.getByRole("button", { name: "Native terminal" })
    ).toBeDisabled()
    expect(screen.getByRole("button", { name: "ACP chat" })).toBeDisabled()
  })

  it("hides the switch for agents without a native terminal adapter", () => {
    renderHeader({ agentType: "gemini" })
    expect(screen.queryByRole("button", { name: "Native terminal" })).toBeNull()
  })
})

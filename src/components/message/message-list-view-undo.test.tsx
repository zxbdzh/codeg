import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, expect, it, vi } from "vitest"

import messages from "@/i18n/messages/en.json"
import {
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
  type ConversationRuntimeSession,
} from "@/stores/conversation-runtime-store"
import { MessageListView } from "./message-list-view"

afterEach(() => {
  cleanup()
  resetConversationRuntimeStore()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it("lets a running conversation open Undo for a saved user message", async () => {
  vi.stubGlobal("fetch", async () => Response.json(null))
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockReturnValue(
    document.body
  )
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(
        private callback: (
          entries: {
            target: Element
            contentRect: { width: number; height: number }
          }[]
        ) => void
      ) {}
      observe(target: Element) {
        queueMicrotask(() =>
          this.callback([{ target, contentRect: { width: 1024, height: 768 } }])
        )
      }
      unobserve() {}
      disconnect() {}
    }
  )
  const session: ConversationRuntimeSession = {
    conversationId: 41,
    externalId: "saved-session",
    dbConversationId: 41,
    detail: {
      summary: {
        id: 41,
        folder_id: 1,
        agent_type: "claude_code",
        title: "Undo while running",
        title_locked: false,
        status: "in_progress",
        kind: "regular",
        model: null,
        git_branch: null,
        external_id: "saved-session",
        message_count: 1,
        child_count: 0,
        created_at: "2026-11-17T01:00:00Z",
        updated_at: "2026-11-17T01:00:00Z",
        pinned_at: null,
      },
      turns: [
        {
          id: "saved-user",
          role: "user",
          timestamp: "2026-11-17T01:00:00Z",
          blocks: [{ type: "text", text: "Retract this instruction" }],
        },
      ],
      session_stats: null,
    },
    detailLoading: false,
    detailError: null,
    acpLoadError: null,
    localTurns: [],
    backgroundTurns: [],
    pendingBackgroundSettlements: [],
    pendingCancelledTurnReports: null,
    optimisticTurns: [],
    liveMessage: null,
    syncState: "idle",
    activeTurnToken: null,
    lastTurnOwned: false,
    liveOwnsActiveTurn: false,
    delegationKickoffText: null,
    sessionStats: null,
    historyAssistantBaseline: null,
    batchBoundaryIndex: null,
    batchBoundaryPrefixHash: null,
    loadingOlderTurns: false,
    olderTurnsPrependEpoch: 0,
    pendingOutOfTurnContent: false,
    pendingCleanup: false,
  }
  useConversationRuntimeStore.setState({
    byConversationId: new Map([[41, session]]),
  })
  let selected = ""
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MessageListView
        conversationId={41}
        imageRoot={null}
        agentType="claude_code"
        availableCommands={[]}
        connStatus="prompting"
        onUndoFromPrompt={(turnId) => {
          selected = turnId
        }}
      />
    </NextIntlClientProvider>
  )
  const action = await screen.findByRole("button", {
    name: messages.ConversationUndo.action,
  })
  expect(action).toBeEnabled()
  await userEvent.click(action)
  expect(selected).toBe("saved-user")
})

import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, expect, it, vi } from "vitest"

import messages from "@/i18n/messages/en.json"
import { getFolderConversation } from "@/lib/api"
import type { DbConversationDetail } from "@/lib/types"
import {
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
  type ConversationRuntimeSession,
} from "@/stores/conversation-runtime-store"
import { MessageListView } from "./message-list-view"

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getFolderConversation: vi.fn(),
}))
vi.mock("./reply-artifacts", () => ({ ReplyArtifacts: () => null }))

afterEach(() => {
  cleanup()
  resetConversationRuntimeStore()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.mocked(getFolderConversation).mockReset()
})

function renderUndoPrompt(kind: "saved" | "stamped" | "local") {
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
  const prompt = {
    id: kind === "saved" ? "saved-user" : "optimistic-user",
    role: "user" as const,
    timestamp: "2026-11-17T01:00:00Z",
    blocks: [{ type: "text" as const, text: "Retract this instruction" }],
  }
  const onUndoFromPrompt = vi.fn()
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
      turns: kind === "local" ? [] : [prompt],
      ...(kind === "stamped"
        ? {
            in_flight_user_turn_id: prompt.id,
            in_flight_user_source_turn_id: "saved-user",
          }
        : {}),
      session_stats: null,
    },
    detailLoading: false,
    detailError: null,
    acpLoadError: null,
    localTurns: kind === "local" ? [prompt] : [],
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
  const savedDetail: DbConversationDetail = {
    ...session.detail!,
    turns: [
      { ...prompt, id: "saved-user" },
      {
        id: "saved-response",
        role: "assistant",
        timestamp: "2026-11-17T01:00:01Z",
        blocks: [{ type: "text", text: "Saved response" }],
      },
    ],
  }
  vi.mocked(getFolderConversation).mockResolvedValue(savedDetail)
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MessageListView
        conversationId={41}
        imageRoot={null}
        agentType="claude_code"
        availableCommands={[]}
        connStatus={kind === "local" ? "connected" : "prompting"}
        onUndoFromPrompt={onUndoFromPrompt}
      />
    </NextIntlClientProvider>
  )
  return onUndoFromPrompt
}

it.each(["saved", "stamped"] as const)(
  "opens Undo for a %s prompt using the transcript's id",
  async (kind) => {
    const onUndoFromPrompt = renderUndoPrompt(kind)
    const action = await screen.findByRole("button", {
      name: messages.ConversationUndo.action,
    })
    expect(action).toBeEnabled()
    await userEvent.click(action)
    expect(onUndoFromPrompt.mock.calls[0]?.[0]).toBe("saved-user")
  }
)

it("offers to refresh a locally completed prompt before requesting Undo", async () => {
  const onUndoFromPrompt = renderUndoPrompt("local")
  await screen.findByText("Retract this instruction")
  expect(
    screen.queryByRole("button", { name: messages.ConversationUndo.action })
  ).not.toBeInTheDocument()
  await userEvent.click(
    screen.getByRole("button", {
      name: messages.Folder.chat.messageList.errorActionReload,
    })
  )
  expect(onUndoFromPrompt).not.toHaveBeenCalled()
  expect(getFolderConversation).toHaveBeenCalledWith(41, expect.anything())
  const undo = await screen.findByRole("button", {
    name: messages.ConversationUndo.action,
  })
  await userEvent.click(undo)
  expect(onUndoFromPrompt.mock.calls[0]?.[0]).toBe("saved-user")
})

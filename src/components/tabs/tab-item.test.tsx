import { act, render, screen } from "@testing-library/react"
import { Reorder } from "motion/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  StaticConnectionStoreProvider,
  type ConnectionStoreApi,
} from "@/contexts/acp-connections-context"
import type { TabItem as TabItemData } from "@/contexts/tab-context"
import enMessages from "@/i18n/messages/en.json"
import { makePaneTestConnection } from "@/lib/conversation-pane-test-helpers"
import { resetTabStore } from "@/stores/tab-store"
import { TabItem } from "./tab-item"

afterEach(() => resetTabStore())

describe("会话标签页待处理状态", () => {
  it.each([false, true])("嵌入模式 %s 下实时区分待处理与运行", (embedded) => {
    const tab: TabItemData = {
      id: "conv-1",
      kind: "conversation",
      folderId: 1,
      conversationId: 1,
      agentType: "codex",
      title: "需要确认的任务",
      isPinned: false,
      status: "in_progress",
    }
    let connection = makePaneTestConnection({ status: "prompting" })
    const listeners = new Set<() => void>()
    const store: ConnectionStoreApi = {
      getConnection: (key) => (key === tab.id ? connection : undefined),
      getConnectPending: () => undefined,
      getConnectError: () => undefined,
      getActiveKey: () => null,
      subscribeActiveKey: () => () => {},
      subscribeKey: (_key, notify) => {
        listeners.add(notify)
        return () => listeners.delete(notify)
      },
    }
    const noop = vi.fn()
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <StaticConnectionStoreProvider store={store}>
          <Reorder.Group values={[tab]} onReorder={noop}>
            <TabItem
              tab={tab}
              embedded={embedded}
              isActive={false}
              isTileMode={false}
              folderName="codeg"
              folderBranch={null}
              isSplit={false}
              canSplitMove={false}
              canMoveToGroup={false}
              moveTargets={[]}
              onSwitch={noop}
              onClose={noop}
              onCloseOthers={noop}
              onCloseAll={noop}
              onPin={noop}
              onToggleTile={noop}
              onSplit={noop}
              onMoveToGroup={noop}
              onToggleSplitOrientation={noop}
              onUnsplit={noop}
              onUnsplitAll={noop}
              isCoarsePointer={false}
              isTouchSorting={false}
              onTouchSortingStart={noop}
              onTouchSortingEnd={noop}
            />
          </Reorder.Group>
        </StaticConnectionStoreProvider>
      </NextIntlClientProvider>
    )
    expect(
      screen.queryByTitle(enMessages.ConversationPanes.status.waiting)
    ).toBeNull()
    act(() => {
      connection = {
        ...connection,
        pendingQuestion: { tool_call_id: "tool-1", question: "是否继续？" },
      }
      listeners.forEach((notify) => notify())
    })
    const waiting = screen.getByTitle(
      enMessages.ConversationPanes.status.waiting
    )
    expect(waiting.querySelector("svg")).not.toBeNull()
    expect(
      container.querySelector('[data-conversation-activity="waiting"]')
    ).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /需要确认的任务/ })).toHaveAttribute(
      "aria-selected",
      "false"
    )

    act(() => {
      connection = { ...connection, pendingQuestion: null }
      listeners.forEach((notify) => notify())
    })
    expect(
      screen.queryByTitle(enMessages.ConversationPanes.status.waiting)
    ).toBeNull()
  })
})

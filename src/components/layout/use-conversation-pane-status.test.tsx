import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ConnectionState } from "@/contexts/acp-connections-context"
import type { ConversationPaneState } from "@/lib/conversation-panes"
import { emptyConversationPane } from "@/lib/conversation-panes"
import { makePaneTestConnection } from "@/lib/conversation-pane-test-helpers"
import type { LiveSessionSnapshot } from "@/lib/types"
import { useBackgroundPaneAttention } from "./use-conversation-pane-status"

const fake = vi.hoisted(() => ({
  fetch: vi.fn(),
  connections: new Map<string, ConnectionState>(),
  state: {
    tabs: [
      { id: "first", conversationId: 2, status: "in_progress" as const },
      { id: "second", conversationId: 3, status: "in_progress" as const },
    ],
    paneState: null as ConversationPaneState | null,
  },
}))

vi.mock("@/lib/api", () => ({
  acpGetSessionSnapshotByConversation: fake.fetch,
}))
vi.mock("@/contexts/acp-connections-context", () => ({
  useOptionalConnectionStore: () => store,
}))
vi.mock("@/stores/tab-store", () => ({
  useTabStore: (select: (state: typeof fake.state) => unknown) =>
    select(fake.state),
}))

const store = {
  getConnection: (key: string) => fake.connections.get(key),
  subscribeKey: () => () => {},
}

function snapshot(
  conversationId: number,
  pending = true,
  eventSeq = 10
): LiveSessionSnapshot {
  return {
    connection_id: `connection-${conversationId}`,
    conversation_id: conversationId,
    folder_id: 1,
    status: pending ? "prompting" : "connected",
    external_id: `session-${conversationId}`,
    live_message: null,
    active_tool_calls: [],
    pending_permission: pending
      ? {
          request_id: `permission-${conversationId}`,
          tool_call_id: `tool-${conversationId}`,
          tool_call: {},
          options: [],
          created_at: "2026-11-17T00:00:00Z",
        }
      : null,
    modes: null,
    current_mode: null,
    config_options: [],
    prompt_capabilities: null,
    usage: null,
    fork_supported: false,
    available_commands: [],
    selectors_ready: true,
    event_seq: eventSeq,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  fake.fetch.mockReset()
  fake.connections.clear()
  const main = emptyConversationPane("main", "主工作区")
  const background = emptyConversationPane("background", "后台任务")
  background.assignments = {
    first: "background-main",
    second: "background-main",
  }
  fake.state.paneState = {
    schemaVersion: 1,
    activePaneId: "main",
    nextOrdinal: 3,
    panes: [main, background],
  }
})

afterEach(() => vi.useRealTimers())

describe("后台 Pane 冷连接提醒", () => {
  it("无需访问后台 Pane 就能汇总两项权限，处理后自动清除", async () => {
    fake.fetch.mockImplementation(async (id: number) => snapshot(id))
    const { result, unmount } = renderHook(() => useBackgroundPaneAttention())
    await act(async () => {})

    expect(fake.fetch.mock.calls.map(([id]) => id)).toEqual([2, 3])
    expect(result.current).toEqual([
      {
        kind: "waiting",
        count: 2,
        paneId: "background",
        paneName: "后台任务",
        tabId: "first",
      },
    ])
    expect(fake.state.paneState?.activePaneId).toBe("main")

    fake.fetch.mockImplementation(async (id: number) => snapshot(id, false, 11))
    await act(async () => vi.advanceTimersByTimeAsync(1500))
    expect(result.current).toEqual([])
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("新快照修复落后的本地状态，但不能覆盖更晚的实时事件", async () => {
    fake.connections.set(
      "first",
      makePaneTestConnection({
        connectionId: "connection-2",
        status: "connected",
        lastAppliedSeq: 5,
      })
    )
    fake.connections.set(
      "second",
      makePaneTestConnection({
        connectionId: "connection-3",
        status: "connected",
        lastAppliedSeq: 20,
      })
    )
    fake.fetch.mockImplementation(async (id: number) => snapshot(id))
    const { result } = renderHook(() => useBackgroundPaneAttention())
    await act(async () => {})
    expect(result.current[0]).toMatchObject({ count: 1, tabId: "first" })

    fake.fetch.mockImplementation(async (id: number) => snapshot(id, false, 11))
    await act(async () => vi.advanceTimersByTimeAsync(1500))
    expect(result.current).toEqual([])
  })

  it("请求故障不会立即假报已解决，但缓存过期后不会永远残留", async () => {
    fake.fetch.mockImplementation(async (id: number) => snapshot(id))
    const { result } = renderHook(() => useBackgroundPaneAttention())
    await act(async () => {})
    expect(result.current[0]?.count).toBe(2)

    fake.fetch.mockRejectedValue(new Error("network unavailable"))
    await act(async () => vi.advanceTimersByTimeAsync(1500))
    expect(result.current[0]?.count).toBe(2)
    await act(async () => vi.advanceTimersByTimeAsync(4500))
    expect(result.current).toEqual([])
  })

  it("慢请求期间不叠加轮询，卸载后不再发起查询", async () => {
    const pending: Array<(value: LiveSessionSnapshot | null) => void> = []
    fake.fetch.mockImplementation(
      () =>
        new Promise<LiveSessionSnapshot | null>((resolve) => {
          pending.push(resolve)
        })
    )
    const { unmount } = renderHook(() => useBackgroundPaneAttention())
    await act(async () => vi.advanceTimersByTimeAsync(6000))
    expect(fake.fetch).toHaveBeenCalledTimes(2)
    unmount()
    await act(async () => pending.forEach((resolve) => resolve(null)))
    await act(async () => vi.advanceTimersByTimeAsync(6000))
    expect(fake.fetch).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})

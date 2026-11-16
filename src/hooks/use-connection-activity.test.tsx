import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ConnectionState } from "@/contexts/acp-connections-context"
import { makePaneTestConnection } from "@/lib/conversation-pane-test-helpers"
import { useConnectionActivity } from "./use-connection-activity"

const fake = vi.hoisted(() => {
  const connections = new Map<string, ConnectionState>()
  const listeners = new Map<string, Set<() => void>>()
  return {
    connections,
    listeners,
    enabled: true,
    store: {
      getConnection: (key: string) => connections.get(key),
      subscribeKey: (key: string, notify: () => void) => {
        const subscribers = listeners.get(key) ?? new Set<() => void>()
        subscribers.add(notify)
        listeners.set(key, subscribers)
        return () => subscribers.delete(notify)
      },
    },
  }
})

vi.mock("@/contexts/acp-connections-context", () => ({
  useOptionalConnectionStore: () => (fake.enabled ? fake.store : null),
}))

function update(key: string, patch: Partial<ConnectionState>) {
  act(() => {
    fake.connections.set(
      key,
      makePaneTestConnection({ ...fake.connections.get(key), ...patch })
    )
    fake.listeners.get(key)?.forEach((notify) => notify())
  })
}

beforeEach(() => {
  fake.connections.clear()
  fake.listeners.clear()
  fake.enabled = true
})

const pendingCases: [string, Partial<ConnectionState>][] = [
  [
    "权限确认",
    {
      pendingPermission: {
        request_id: "permission-1",
        tool_call: {},
        options: [],
      },
    },
  ],
  [
    "工具提问",
    {
      pendingQuestion: {
        tool_call_id: "tool-1",
        question: "是否继续？",
      },
    },
  ],
  [
    "结构化提问",
    {
      pendingAskQuestion: {
        question_id: "question-1",
        questions: [],
        created_at: "2026-11-16T00:00:00Z",
      },
    },
  ],
  [
    "计划审批",
    {
      pendingPlanApproval: {
        approval_id: "approval-1",
        tool_call_id: "tool-1",
        plan_markdown: "执行计划",
        created_at: "2026-11-16T00:00:00Z",
      },
    },
  ],
]

describe("会话活动订阅", () => {
  it.each(pendingCases)(
    "%s 独立显示为待处理，处理后恢复运行",
    (_name, pending) => {
      update("first", { status: "prompting" })
      const { result } = renderHook(() =>
        useConnectionActivity("first", "in_progress")
      )
      expect(result.current).toBe("running")
      update("first", pending)
      expect(result.current).toBe("waiting")
      update("first", {
        pendingPermission: null,
        pendingQuestion: null,
        pendingAskQuestion: null,
        pendingPlanApproval: null,
      })
      expect(result.current).toBe("running")
    }
  )

  it("仅活动类别改变时重绘，不受正文事件或其他会话影响", () => {
    update("first", { status: "prompting" })
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useConnectionActivity("first")
    })
    const initialRenders = renders
    update("first", { lastAppliedSeq: 12 })
    update("second", pendingCases[0][1])
    expect(renders).toBe(initialRenders)
    expect(result.current).toBe("running")
    update("first", pendingCases[0][1])
    expect(result.current).toBe("waiting")
    expect(renders).toBe(initialRenders + 1)
  })

  it("更换会话键时解除旧订阅，读取新会话", () => {
    update("first", { status: "prompting" })
    update("second", pendingCases[1][1])
    const { result, rerender, unmount } = renderHook(
      ({ contextKey }) => useConnectionActivity(contextKey),
      { initialProps: { contextKey: "first" } }
    )
    rerender({ contextKey: "second" })
    expect(result.current).toBe("waiting")
    expect(fake.listeners.get("first")?.size).toBe(0)
    expect(fake.listeners.get("second")?.size).toBe(1)
    unmount()
    expect(fake.listeners.get("second")?.size).toBe(0)
  })

  it("未提供连接上下文时沿用手工完成状态", () => {
    fake.enabled = false
    const { result } = renderHook(() =>
      useConnectionActivity("first", "completed")
    )
    expect(result.current).toBe("completed")
  })
})

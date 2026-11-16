import { describe, expect, it } from "vitest"
import type { ConnectionState } from "@/contexts/acp-connections-context"
import { emptyConversationPane } from "@/lib/conversation-panes"
import { makePaneTestConnection } from "@/lib/conversation-pane-test-helpers"
import {
  connectionActivityKind,
  summarizePaneActivity,
} from "./conversation-pane-status"

function connection(status: ConnectionState["status"]) {
  return makePaneTestConnection({ status })
}

describe("灵动岛状态", () => {
  it("只有存在错误信息时才按错误级别显示错误", () => {
    expect(connectionActivityKind(connection("prompting"), undefined)).toBe(
      "running"
    )
    expect(
      connectionActivityKind(
        { ...connection("connected"), error: "连接失败" },
        undefined
      )
    ).toBe("error")
    expect(
      connectionActivityKind(
        {
          ...connection("prompting"),
          error: "请求较慢",
          errorLevel: "warning",
        },
        undefined
      )
    ).toBe("running")
  })

  it("等待操作优先于运行，未决错误优先于空闲", () => {
    expect(
      connectionActivityKind(
        {
          ...connection("prompting"),
          pendingPermission: {
            request_id: "permission-1",
            tool_call: {},
            options: [],
          },
        },
        undefined
      )
    ).toBe("waiting")
    expect(connectionActivityKind(connection("error"), "completed")).toBe(
      "error"
    )
    expect(connectionActivityKind(connection("connected"), "completed")).toBe(
      "completed"
    )
  })

  it("只汇总当前 Pane 的会话，并返回最高优先级的数量", () => {
    const pane = emptyConversationPane("pane-main", "工作")
    pane.assignments = { first: "g-main", second: "g-main" }
    const connections = new Map([
      ["first", connection("prompting")],
      ["second", connection("connected")],
      ["other", connection("error")],
    ])
    expect(
      summarizePaneActivity(
        pane,
        [
          { id: "first" },
          { id: "second", status: "completed" },
          { id: "other" },
        ],
        (id) => connections.get(id)
      )
    ).toEqual({ kind: "running", count: 1 })
  })

  it("待处理单独计数，不混入同 Pane 的运行会话或其他 Pane 的等待", () => {
    const pane = emptyConversationPane("pane-main", "工作")
    pane.assignments = {
      permission: "g-main",
      question: "g-main",
      running: "g-main",
    }
    const waiting = makePaneTestConnection({
      status: "prompting",
      pendingQuestion: { tool_call_id: "tool-1", question: "是否继续？" },
    })
    const connections = new Map([
      ["permission", waiting],
      ["question", waiting],
      ["running", connection("prompting")],
      ["other-pane", waiting],
    ])
    expect(
      summarizePaneActivity(
        pane,
        Array.from(connections.keys(), (id) => ({ id })),
        (id) => connections.get(id)
      )
    ).toEqual({ kind: "waiting", count: 2 })
  })
})

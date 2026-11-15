import { describe, expect, it } from "vitest"
import type { ConnectionState } from "@/contexts/acp-connections-context"
import { emptyConversationPane } from "@/lib/conversation-panes"
import {
  connectionActivityKind,
  summarizePaneActivity,
} from "./conversation-pane-status"

function connection(status: ConnectionState["status"]) {
  return {
    status,
    pendingPermission: null,
    pendingQuestion: null,
    pendingAskQuestion: null,
    pendingPlanApproval: null,
    sessionFailures: [],
    errorLevel: null,
  } as ConnectionState
}

describe("灵动岛状态", () => {
  it("等待操作优先于运行，未决错误优先于空闲", () => {
    expect(
      connectionActivityKind(
        {
          ...connection("prompting"),
          pendingPermission: {},
        } as ConnectionState,
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
})

import type { ConnectionState } from "@/contexts/acp-connections-context"
import type { ConversationPane } from "@/lib/conversation-panes"
import type { ConversationStatus } from "@/lib/types"

export type PaneActivityKind = "waiting" | "error" | "running" | "completed"

export interface PaneActivitySummary {
  kind: PaneActivityKind
  count: number
}

/** 等待操作优先于运行；只有已经平静下来的会话才显示完成状态。 */
export function connectionActivityKind(
  connection: ConnectionState | undefined,
  manualStatus: ConversationStatus | undefined
): PaneActivityKind | null {
  if (!connection) {
    return manualStatus === "completed" ? "completed" : null
  }
  if (
    connection.pendingPermission ||
    connection.pendingQuestion ||
    connection.pendingAskQuestion ||
    connection.pendingPlanApproval
  ) {
    return "waiting"
  }
  // 错误级别有默认值，必须同时存在错误信息才能判定实际出错。
  if (
    connection.status === "error" ||
    (Boolean(connection.error) && connection.errorLevel === "error") ||
    connection.sessionFailures.some(
      (failure) => !failure.resolved && failure.severity === "error"
    )
  ) {
    return "error"
  }
  if (connection.status === "prompting") return "running"
  return manualStatus === "completed" ? "completed" : null
}

export function summarizePaneActivity(
  pane: ConversationPane,
  tabs: ReadonlyArray<{
    id: string
    status?: ConversationStatus
  }>,
  getConnection: (tabId: string) => ConnectionState | undefined
): PaneActivitySummary | null {
  const counts: Record<PaneActivityKind, number> = {
    waiting: 0,
    error: 0,
    running: 0,
    completed: 0,
  }
  for (const tab of tabs) {
    if (!Object.prototype.hasOwnProperty.call(pane.assignments, tab.id)) {
      continue
    }
    const kind = connectionActivityKind(getConnection(tab.id), tab.status)
    if (kind) counts[kind] += 1
  }
  for (const kind of ["waiting", "error", "running", "completed"] as const) {
    if (counts[kind] > 0) return { kind, count: counts[kind] }
  }
  return null
}

export function samePaneActivity(
  previous: PaneActivitySummary | null,
  next: PaneActivitySummary | null
) {
  return previous?.kind === next?.kind && previous?.count === next?.count
}

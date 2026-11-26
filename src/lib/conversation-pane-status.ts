import type { ConnectionState } from "@/contexts/acp-connections-context"
import type {
  ConversationPane,
  ConversationPaneState,
} from "@/lib/conversation-panes"
import type { ConversationStatus } from "@/lib/types"

export type PaneActivityKind = "waiting" | "error" | "running" | "completed"

export interface PaneActivitySummary {
  kind: PaneActivityKind
  count: number
}

export interface PaneAttentionSummary extends PaneActivitySummary {
  kind: "waiting" | "error"
  paneId: string
  paneName: string
  tabId: string
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
  getConnection: (tabId: string) => ConnectionState | undefined,
  getFallbackKind?: (tabId: string) => PaneActivityKind | null | undefined
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
    const fallback = getFallbackKind?.(tab.id)
    const kind =
      fallback === undefined
        ? connectionActivityKind(getConnection(tab.id), tab.status)
        : fallback
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

/** 后台 Pane 只主动提醒需要介入的状态，不能让运行和完成状态淹没待处理入口。 */
export function summarizeBackgroundPaneAttention(
  paneState: ConversationPaneState | null,
  tabs: ReadonlyArray<{ id: string; status?: ConversationStatus }>,
  getConnection: (tabId: string) => ConnectionState | undefined,
  getFallbackKind?: (tabId: string) => PaneActivityKind | null | undefined
): PaneAttentionSummary[] {
  if (!paneState) return []
  const notices: PaneAttentionSummary[] = []
  for (const pane of paneState.panes) {
    if (pane.id === paneState.activePaneId) continue
    const activity = summarizePaneActivity(
      pane,
      tabs,
      getConnection,
      getFallbackKind
    )
    if (
      !activity ||
      (activity.kind !== "waiting" && activity.kind !== "error")
    ) {
      continue
    }
    const { kind } = activity
    const target = tabs.find((tab) => {
      if (!Object.prototype.hasOwnProperty.call(pane.assignments, tab.id)) {
        return false
      }
      const fallback = getFallbackKind?.(tab.id)
      return (
        (fallback === undefined
          ? connectionActivityKind(getConnection(tab.id), tab.status)
          : fallback) === kind
      )
    })
    if (target) {
      notices.push({
        kind,
        count: activity.count,
        paneId: pane.id,
        paneName: pane.name,
        tabId: target.id,
      })
    }
  }
  return notices.sort(
    (previous, next) =>
      Number(previous.kind !== "waiting") - Number(next.kind !== "waiting")
  )
}

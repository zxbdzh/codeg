export type ConversationPaneSwitcherPosition = {
  /**
   * 相对可用横向空间的归一化偏移：-1 为最左，0 为居中，1 为最右。
   * 存比例而不是像素，窗口缩放或侧栏变化后仍能保持相对位置。
   */
  x: number
  /** 相对可用纵向空间的归一化偏移：0 为顶部，1 为底部。 */
  y: number
}

export const CONVERSATION_PANE_SWITCHER_POSITION_KEY =
  "settings:conversation-pane-switcher-position:v1"

export const DEFAULT_CONVERSATION_PANE_SWITCHER_POSITION: ConversationPaneSwitcherPosition =
  { x: 0, y: 0 }

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 把任意来源的数据收敛到可用的归一化范围，避免旧数据把灵动岛移出屏幕。 */
export function normalizeConversationPaneSwitcherPosition(
  value: unknown
): ConversationPaneSwitcherPosition {
  if (value == null || typeof value !== "object") {
    return { ...DEFAULT_CONVERSATION_PANE_SWITCHER_POSITION }
  }
  const candidate = value as { x?: unknown; y?: unknown }
  const x =
    typeof candidate.x === "number" && Number.isFinite(candidate.x)
      ? clamp(candidate.x, -1, 1)
      : DEFAULT_CONVERSATION_PANE_SWITCHER_POSITION.x
  const y =
    typeof candidate.y === "number" && Number.isFinite(candidate.y)
      ? clamp(candidate.y, 0, 1)
      : DEFAULT_CONVERSATION_PANE_SWITCHER_POSITION.y
  return { x, y }
}

export function readConversationPaneSwitcherPosition(
  storage: Pick<Storage, "getItem"> | null = typeof window === "undefined"
    ? null
    : window.localStorage
): ConversationPaneSwitcherPosition {
  if (!storage) return { ...DEFAULT_CONVERSATION_PANE_SWITCHER_POSITION }
  try {
    const raw = storage.getItem(CONVERSATION_PANE_SWITCHER_POSITION_KEY)
    return raw == null
      ? { ...DEFAULT_CONVERSATION_PANE_SWITCHER_POSITION }
      : normalizeConversationPaneSwitcherPosition(JSON.parse(raw))
  } catch {
    // 隐私模式或损坏的 JSON 都应退回默认位置，而不是阻断整个切换栏渲染。
    return { ...DEFAULT_CONVERSATION_PANE_SWITCHER_POSITION }
  }
}

export function writeConversationPaneSwitcherPosition(
  position: ConversationPaneSwitcherPosition,
  storage: Pick<Storage, "setItem"> | null = typeof window === "undefined"
    ? null
    : window.localStorage
): void {
  if (!storage) return
  try {
    storage.setItem(
      CONVERSATION_PANE_SWITCHER_POSITION_KEY,
      JSON.stringify(normalizeConversationPaneSwitcherPosition(position))
    )
  } catch {
    // 存储不可用只影响下次打开时的位置，不影响当前拖拽。
  }
}

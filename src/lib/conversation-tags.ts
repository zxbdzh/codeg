/**
 * Conversation tags: the pure rules every tag surface shares — which tags a
 * conversation may carry, the order they are drawn in, the colours offered for
 * new ones, and what a sidebar tag filter matches.
 *
 * Scope (mirrors `conversation_tag_service` in the backend): a tag with
 * `folder_id === null` is GLOBAL and fits every conversation, chat-mode ones
 * included; any other tag belongs to one ROOT folder and fits only the
 * conversations of that folder and its worktrees. Chat folders never own tags.
 */
import type { CSSProperties } from "react"
import { labelSwatch } from "@/lib/forge-label-color"
import { scorePinyinMatch } from "@/lib/pinyin-match"
import type {
  ConversationTagDetail,
  DbConversationSummary,
  FolderDetail,
} from "@/lib/types"

/** Longest name the backend keeps (it trims and caps to this). */
export const MAX_TAG_NAME_LENGTH = 64

/**
 * The colours offered when creating or recolouring a tag: a strong row and a
 * soft row in the same hue order.
 *
 * Every one of them was checked against the chip treatment it gets
 * (`labelSwatch`, GitHub's label algorithm): in the light theme the colour is
 * the fill and the text is black or white by its perceived lightness, in the
 * dark theme the fill is the colour at 18% and the text the colour lifted to a
 * readable lightness. Measured over the sidebar's own surfaces (#fafafa light,
 * #171717 dark), all eighteen clear 4.5:1 (AA for small text) in both themes —
 * the strong row's worst is 4.62:1 (gray, light), the soft row's 7.95:1 (red,
 * dark). Re-measure before changing a value: a nicer-looking shade near the
 * black/white text threshold (perceived lightness ≈ 0.45) can drop to 3.5:1
 * either way.
 */
export const TAG_COLOR_PRESETS = [
  "#cf222e",
  "#bc4c00",
  "#9a6700",
  "#1a7f37",
  "#0f766e",
  "#0969da",
  "#8250df",
  "#bf3989",
  "#6e7781",
  "#fecaca",
  "#fed7aa",
  "#fde68a",
  "#bbf7d0",
  "#99f6e4",
  "#bfdbfe",
  "#ddd6fe",
  "#fbcfe8",
  "#e2e8f0",
] as const

/** How many presets make up the strong row (the rest are the soft row). */
export const TAG_COLOR_STRONG_COUNT = 9

/** The branch tag's colour until the user picks one — the backend's default
 *  too (`DEFAULT_BRANCH_TAG_COLOR`): the gray preset, the last a new tag is
 *  started on. */
export const DEFAULT_BRANCH_TAG_COLOR = "#6e7781"

/** A branch chip as drawn: the conversation's branch, in the branch tag's
 *  colour. */
export interface BranchChipView {
  name: string
  color: string
}

/**
 * The colour a NEW tag starts with: the first strong preset none of
 * `neighbours` — the tags it will be seen beside (the global ones plus, for a
 * folder's tag, that folder's) — uses yet, so tags created back to back come
 * out distinguishable without the user touching the picker. Once all are taken
 * it cycles by count.
 */
export function pickNextTagColor(
  neighbours: readonly ConversationTagDetail[]
): string {
  const used = new Set(neighbours.map((t) => t.color.toLowerCase()))
  const strong = TAG_COLOR_PRESETS.slice(0, TAG_COLOR_STRONG_COUNT)
  const free = strong.find((c) => !used.has(c))
  return free ?? strong[neighbours.length % strong.length]
}

/** `#rgb` / `#rrggbb` (any case) → lowercase `#rrggbb`, or null. The backend
 *  applies the same rule; this lets the UI validate before sending. */
export function normalizeTagColor(value: string): string | null {
  const trimmed = value.trim()
  const short = /^#([0-9a-f]{3})$/i.exec(trimmed)
  if (short) {
    return `#${short[1]
      .split("")
      .map((c) => c + c)
      .join("")}`.toLowerCase()
  }
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toLowerCase() : null
}

/**
 * The chip's colours for both themes, as the custom properties `.forge-label`
 * reads (globals.css picks the light or dark set by the root's theme class, so
 * there is no flash of the wrong one on a cold start). Conversation tags and
 * forge labels are the same kind of thing — a user's one colour that has to
 * survive both themes — so they share one treatment.
 */
export function tagChipStyle(color: string): CSSProperties | undefined {
  return labelSwatch(color)
}

/** The folder whose tags a conversation in `folder` is offered: its root for a
 *  regular folder (worktrees follow their repo), none for a chat folder. */
export function tagScopeFolderId(
  folder: Pick<FolderDetail, "id" | "parent_id" | "kind"> | null | undefined
): number | null {
  if (!folder || folder.kind !== "regular") return null
  return folder.parent_id ?? folder.id
}

/** Whether `tag` may go on a conversation whose folder scope is `scope`. */
export function tagFitsScope(
  tag: ConversationTagDetail,
  scope: number | null
): boolean {
  return tag.folder_id === null || tag.folder_id === scope
}

/**
 * Display order for a set of tags: global ones first, then folder-owned ones
 * grouped by folder, each group in its `sort_order` (ties on id) — the order
 * the backend lists them in, re-established here so a set assembled from any
 * source reads the same everywhere.
 */
export function compareTags(
  a: ConversationTagDetail,
  b: ConversationTagDetail
): number {
  if (a.folder_id !== b.folder_id) {
    if (a.folder_id === null) return -1
    if (b.folder_id === null) return 1
    return a.folder_id - b.folder_id
  }
  return a.sort_order - b.sort_order || a.id - b.id
}

const NO_TAGS: readonly ConversationTagDetail[] = []

/**
 * Resolve a conversation's `tag_ids` to the tags this client knows, in display
 * order. Unknown ids are dropped: a tag deleted elsewhere is not followed by
 * per-conversation upserts, so a summary can name one for a while — it must
 * simply not be drawn (nor counted toward a "+N").
 */
export function resolveTags(
  tagIds: readonly number[] | undefined,
  tagsById: ReadonlyMap<number, ConversationTagDetail>
): readonly ConversationTagDetail[] {
  if (!tagIds || tagIds.length === 0) return NO_TAGS
  const out: ConversationTagDetail[] = []
  for (const id of tagIds) {
    const tag = tagsById.get(id)
    if (tag) out.push(tag)
  }
  if (out.length === 0) return NO_TAGS
  return out.sort(compareTags)
}

/** Case-insensitive name match within a scope, mirroring the backend's
 *  uniqueness rule (it folds with Unicode lowercase too). */
export function findTagByName(
  tags: readonly ConversationTagDetail[],
  scope: number | null,
  name: string
): ConversationTagDetail | undefined {
  const key = name.trim().toLowerCase()
  if (!key) return undefined
  return tags.find((t) => t.folder_id === scope && t.name.toLowerCase() === key)
}

// ── Tag search ───────────────────────────────────────────────────────────

const TAG_SCORE_BASE = 1_000_000

/** 返回 query 在候选文本中的首个命中位置；不是子序列时返回 -1。 */
function subsequenceFirstIndex(query: string, candidate: string): number {
  let queryIndex = 0
  let firstIndex = -1
  for (
    let candidateIndex = 0;
    candidateIndex < candidate.length && queryIndex < query.length;
    candidateIndex++
  ) {
    if (candidate[candidateIndex] === query[queryIndex]) {
      if (queryIndex === 0) firstIndex = candidateIndex
      queryIndex++
    }
  }
  return queryIndex === query.length ? firstIndex : -1
}

/**
 * 标签数量通常很小，所以这里用短字符串编辑距离换取输入容错；
 * 只对较短查询开放一两个字符的误差，避免输入一个常见字就命中整组标签。
 */
function boundedEditDistance(
  query: string,
  candidate: string,
  maxDistance: number
): number | null {
  if (Math.abs(query.length - candidate.length) > maxDistance) return null

  let previous = Array.from({ length: candidate.length + 1 }, (_, i) => i)
  for (let queryIndex = 1; queryIndex <= query.length; queryIndex++) {
    const current = [queryIndex]
    let rowMinimum = current[0]

    for (
      let candidateIndex = 1;
      candidateIndex <= candidate.length;
      candidateIndex++
    ) {
      const substitution =
        previous[candidateIndex - 1] +
        (query[queryIndex - 1] === candidate[candidateIndex - 1] ? 0 : 1)
      const insertion = current[candidateIndex - 1] + 1
      const deletion = previous[candidateIndex] + 1
      const value = Math.min(substitution, insertion, deletion)
      current[candidateIndex] = value
      rowMinimum = Math.min(rowMinimum, value)
    }

    // 这一行已经不可能在阈值内，提前结束可避免标签很多时无谓计算。
    if (rowMinimum > maxDistance) return null
    previous = current
  }

  return previous[candidate.length] <= maxDistance
    ? previous[candidate.length]
    : null
}

function normalizeTagSearchText(value: string): string {
  return value.trim().normalize("NFKC").toLowerCase()
}

/**
 * 给一个标签名评分：精确、前缀、包含、跳跃、编辑距离、拼音依次降级。
 * 分数只用于排序，不暴露给 UI，后续替换搜索策略时不会影响调用方。
 */
export function scoreTagMatch(query: string, name: string): number | null {
  const normalizedQuery = normalizeTagSearchText(query)
  const normalizedName = normalizeTagSearchText(name)
  if (!normalizedQuery) return null

  if (normalizedName === normalizedQuery) {
    return 6 * TAG_SCORE_BASE - normalizedName.length
  }
  if (normalizedName.startsWith(normalizedQuery)) {
    return 5 * TAG_SCORE_BASE - normalizedName.length
  }

  const substringIndex = normalizedName.indexOf(normalizedQuery)
  if (substringIndex !== -1) {
    return 4 * TAG_SCORE_BASE - substringIndex * 1_000 - normalizedName.length
  }

  const subsequenceIndex = subsequenceFirstIndex(
    normalizedQuery,
    normalizedName
  )
  if (subsequenceIndex !== -1) {
    return 3 * TAG_SCORE_BASE - subsequenceIndex * 1_000 - normalizedName.length
  }

  // 单字符查询不做编辑距离，否则几乎所有单字标签都会变成候选。
  const maxDistance =
    normalizedQuery.length >= 2
      ? Math.min(2, Math.max(1, Math.floor(normalizedQuery.length / 3)))
      : 0
  const distance = boundedEditDistance(
    normalizedQuery,
    normalizedName,
    maxDistance
  )
  return distance == null
    ? scorePinyinMatch(normalizedQuery, normalizedName)
    : 2 * TAG_SCORE_BASE - normalizedName.length - distance
}

/**
 * 在标签入口复用同一套模糊排序。空查询保留后端顺序，非空查询只返回
 * 能命中的标签；稳定排序保证同分标签不会在每次输入时跳动。
 */
export function rankTagMatches<T extends { name: string }>(
  query: string,
  tags: readonly T[]
): T[] {
  const normalizedQuery = normalizeTagSearchText(query)
  if (!normalizedQuery) return tags.slice()

  const scored: Array<{ tag: T; score: number; index: number }> = []
  tags.forEach((tag, index) => {
    const score = scoreTagMatch(normalizedQuery, tag.name)
    if (score != null) scored.push({ tag, score, index })
  })
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.map(({ tag }) => tag)
}

// ── Sidebar tag filter ───────────────────────────────────────────────────

/** `any`: a conversation matches if it carries at least one selected tag.
 *  `all`: only if it carries every one of them. */
export type TagFilterMode = "any" | "all"

export interface TagFilter {
  tagIds: readonly number[]
  mode: TagFilterMode
}

export const EMPTY_TAG_FILTER: TagFilter = { tagIds: [], mode: "any" }

/**
 * Keep only the ids of tags that still exist. A filter outlives its tags — it
 * is persisted, and a tag can be deleted from another window — and a dead id
 * would otherwise turn `all` into "nothing matches" with no visible reason.
 * Returns the SAME object when nothing was dropped, so callers' memos hold.
 */
export function pruneTagFilter(
  filter: TagFilter,
  tagsById: ReadonlyMap<number, ConversationTagDetail>
): TagFilter {
  const kept = filter.tagIds.filter((id) => tagsById.has(id))
  if (kept.length === filter.tagIds.length) return filter
  return { ...filter, tagIds: kept }
}

export function isTagFilterActive(filter: TagFilter): boolean {
  return filter.tagIds.length > 0
}

/** Whether a conversation passes `filter`. An inactive filter passes all. */
export function matchesTagFilter(
  conversation: Pick<DbConversationSummary, "tag_ids">,
  filter: TagFilter
): boolean {
  if (filter.tagIds.length === 0) return true
  const own = conversation.tag_ids
  if (!own || own.length === 0) return false
  return filter.mode === "all"
    ? filter.tagIds.every((id) => own.includes(id))
    : filter.tagIds.some((id) => own.includes(id))
}

/** Toggle one tag in a filter's selection, preserving the order picked. */
export function toggleTagInFilter(filter: TagFilter, tagId: number): TagFilter {
  return filter.tagIds.includes(tagId)
    ? { ...filter, tagIds: filter.tagIds.filter((id) => id !== tagId) }
    : { ...filter, tagIds: [...filter.tagIds, tagId] }
}

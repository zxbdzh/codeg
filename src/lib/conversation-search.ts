import { scoreTagMatch } from "@/lib/conversation-tags"
import { scorePinyinMatch } from "@/lib/pinyin-match"
import type { ConversationTagDetail } from "@/lib/types"

interface ConversationSearchCandidate {
  title: string | null
  tag_ids?: readonly number[]
}

/** 标题优先，其次按标签匹配程度排序；同分保留后端的会话顺序。 */
export function rankConversationSearchMatches<
  T extends ConversationSearchCandidate,
>(
  query: string,
  conversations: readonly T[],
  tags: readonly ConversationTagDetail[]
): T[] {
  const needle = query.trim().normalize("NFKC").toLowerCase()
  if (!needle) return []

  const tagScores = new Map<number, number>()
  for (const tag of tags) {
    const score = scoreTagMatch(needle, tag.name)
    if (score != null) tagScores.set(tag.id, score)
  }

  return conversations
    .map((conversation) => {
      const title = (conversation.title ?? "").normalize("NFKC").toLowerCase()
      const titleScore = title.includes(needle)
        ? 7_000_000
        : (scorePinyinMatch(needle, title) ?? 0)
      const score = (conversation.tag_ids ?? []).reduce(
        (best, id) => Math.max(best, tagScores.get(id) ?? 0),
        titleScore
      )
      return { conversation, score }
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .map(({ conversation }) => conversation)
}

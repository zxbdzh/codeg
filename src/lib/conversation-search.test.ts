import { describe, expect, it } from "vitest"
import { rankConversationSearchMatches } from "./conversation-search"
import type { ConversationTagDetail } from "./types"

const tags: ConversationTagDetail[] = [
  { id: 1, name: "数字人", folder_id: null, color: "#0969da", sort_order: 1 },
  { id: 2, name: "DevOps", folder_id: 7, color: "#0969da", sort_order: 2 },
  { id: 3, name: "数字人调研", folder_id: 7, color: "#0969da", sort_order: 3 },
]

describe("rankConversationSearchMatches", () => {
  it.each(["shuziren", "szr"])(
    "finds conversations by pinyin tag query %s",
    (query) => {
      const conversations = [{ title: "跨多轮主线", tag_ids: [1] }]
      expect(rankConversationSearchMatches(query, conversations, tags)).toEqual(
        conversations
      )
    }
  )

  it("matches a Chinese title by pinyin without requiring any tags", () => {
    const conversations = [{ title: "库存管理" }, { title: "自动化" }]
    expect(
      rankConversationSearchMatches("kucun", conversations, []).map(
        (conversation) => conversation.title
      )
    ).toEqual(["库存管理"])
  })

  it("matches either the title or assigned tag, without duplicating a conversation", () => {
    const conversations = [
      { id: 1, title: "数字人方案", tag_ids: [1, 3] },
      { id: 2, title: "跨多轮主线", tag_ids: [1] },
      { id: 3, title: "库存管理" },
    ]
    expect(
      rankConversationSearchMatches("数字人", conversations, tags).map(
        (conversation) => conversation.id
      )
    ).toEqual([1, 2])
  })

  it("uses the existing tag typo and subsequence matching rules", () => {
    const conversations = [{ title: "跨多轮主线", tag_ids: [1] }]
    expect(
      rankConversationSearchMatches("数子人", conversations, tags)
    ).toEqual(conversations)
    expect(rankConversationSearchMatches("数人", conversations, tags)).toEqual(
      conversations
    )
  })

  it("normalizes full-width and mixed-case queries", () => {
    const conversations = [
      { id: 1, title: null, tag_ids: [2] },
      { id: 2, title: "DEVOPS setup" },
    ]
    expect(
      rankConversationSearchMatches(" ＤｅｖＯｐｓ ", conversations, tags).map(
        (conversation) => conversation.id
      )
    ).toEqual([2, 1])
  })

  it("ranks title matches before exact tags, then weaker tag matches", () => {
    const conversations = [
      { id: 1, title: "research", tag_ids: [3] },
      { id: 2, title: "implementation", tag_ids: [1] },
      { id: 3, title: "数字人" },
    ]
    expect(
      rankConversationSearchMatches("数字人", conversations, tags).map(
        (conversation) => conversation.id
      )
    ).toEqual([3, 2, 1])
    expect(conversations.map((conversation) => conversation.id)).toEqual([
      1, 2, 3,
    ])
  })

  it("ignores unknown or deleted tags and does not offer unrelated conversations", () => {
    const conversations = [
      { title: null, tag_ids: [99] },
      { title: "库存" },
      { title: "自动化", tag_ids: [2] },
    ]
    expect(
      rankConversationSearchMatches("数字人", conversations, tags)
    ).toEqual([])
    expect(rankConversationSearchMatches("", conversations, tags)).toEqual([])
    expect(rankConversationSearchMatches("   ", conversations, tags)).toEqual(
      []
    )
  })

  it("preserves the backend order for equally relevant matches", () => {
    const conversations = [
      { title: "latest", tag_ids: [1] },
      { title: "older", tag_ids: [1] },
    ]
    expect(
      rankConversationSearchMatches("数字人", conversations, tags)
    ).toEqual(conversations)
  })
})

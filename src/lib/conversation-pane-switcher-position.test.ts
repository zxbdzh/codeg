import { beforeEach, describe, expect, it } from "vitest"
import {
  CONVERSATION_PANE_SWITCHER_POSITION_KEY,
  DEFAULT_CONVERSATION_PANE_SWITCHER_POSITION,
  normalizeConversationPaneSwitcherPosition,
  readConversationPaneSwitcherPosition,
  writeConversationPaneSwitcherPosition,
} from "./conversation-pane-switcher-position"

describe("灵动岛位置存储", () => {
  beforeEach(() => localStorage.clear())

  it("空值和损坏数据都回到顶部居中", () => {
    expect(readConversationPaneSwitcherPosition()).toEqual(
      DEFAULT_CONVERSATION_PANE_SWITCHER_POSITION
    )
    localStorage.setItem(CONVERSATION_PANE_SWITCHER_POSITION_KEY, "{broken")
    expect(readConversationPaneSwitcherPosition()).toEqual(
      DEFAULT_CONVERSATION_PANE_SWITCHER_POSITION
    )
  })

  it("把越界和非有限数值收敛到安全范围", () => {
    expect(normalizeConversationPaneSwitcherPosition({ x: 2, y: -3 })).toEqual({
      x: 1,
      y: 0,
    })
    expect(
      normalizeConversationPaneSwitcherPosition({ x: Number.NaN, y: 9 })
    ).toEqual({ x: 0, y: 1 })
  })

  it("位置可持久化并保持比例", () => {
    writeConversationPaneSwitcherPosition({ x: -0.25, y: 0.75 })
    expect(readConversationPaneSwitcherPosition()).toEqual({
      x: -0.25,
      y: 0.75,
    })
  })

  it("存储抛错时静默退回默认值", () => {
    const storage = {
      getItem: () => {
        throw new Error("denied")
      },
      setItem: () => {
        throw new Error("denied")
      },
    }
    expect(readConversationPaneSwitcherPosition(storage)).toEqual(
      DEFAULT_CONVERSATION_PANE_SWITCHER_POSITION
    )
    expect(() =>
      writeConversationPaneSwitcherPosition({ x: 0.5, y: 0.5 }, storage)
    ).not.toThrow()
  })
})

import { describe, expect, it } from "vitest"
import { scorePinyinMatch } from "./pinyin-match"

describe("scorePinyinMatch", () => {
  it.each([
    ["shuziren", "数字人"],
    ["szr", "数字人"],
    ["shuz", "数字人"],
    ["zi", "数字人"],
    ["shu-zi-ren", "数字人"],
    ["shu'zi'ren", "数字人"],
    ["shu字ren", "数字人"],
    ["aiszr", "AI 数字人"],
    ["szrapi", "数字人API"],
    ["cqbs", "重庆部署"],
    ["chongqing", "重庆部署"],
    ["zhongqing", "重庆部署"],
    ["lvbu", "吕布"],
    ["lübu", "吕布"],
    ["ＳＺＲ", "數字人"],
  ])("matches %s against %s", (query, text) => {
    expect(scorePinyinMatch(query, text)).toBeGreaterThan(0)
  })

  it.each(["", "  ", "s", "123", "uziren", "zzzz"])(
    "does not match an empty, short or unrelated query %s",
    (query) => {
      expect(scorePinyinMatch(query, "数字人")).toBeNull()
    }
  )

  it("leaves non-Chinese text to the literal matcher", () => {
    expect(scorePinyinMatch("dev", "DevOps")).toBeNull()
  })

  it("prefers a compact match at the start of the name", () => {
    expect(scorePinyinMatch("szr", "数字人")).toBeGreaterThan(
      scorePinyinMatch("szr", "开发数字人")!
    )
  })
})

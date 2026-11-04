import { match } from "pinyin-pro"

const HAN_CHARACTER = /\p{Script=Han}/u
const LATIN_LETTER = /[a-z]/

/** 拼音仅作兜底，分数低于原文和拼写容错；英文候选不走拼音转换。 */
export function scorePinyinMatch(query: string, text: string): number | null {
  const normalizedText = text.normalize("NFKC").toLowerCase()
  const normalizedQuery = query
    .trim()
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s'’-]+/g, "")
  // 一个字母会召回过多中文结果，至少输入两个字符再启用拼音匹配。
  if (
    normalizedQuery.length < 2 ||
    !LATIN_LETTER.test(normalizedQuery) ||
    !HAN_CHARACTER.test(normalizedText)
  ) {
    return null
  }

  const indexes = match(normalizedText, normalizedQuery, {
    precision: "first",
    lastPrecision: "start",
    v: true,
  })
  if (!indexes?.length) return null

  const first = indexes[0]
  const gaps = indexes[indexes.length - 1] - first + 1 - indexes.length
  return (
    1_000_000 -
    Math.min(first, 999) * 1_000 -
    Math.min(gaps, 999) * 10 -
    Math.min(normalizedText.length, 999)
  )
}

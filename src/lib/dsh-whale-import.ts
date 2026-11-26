import {
  parseWhaleOptions,
  type WhaleBubble,
  type WhaleModule,
  type WhaleOptions,
} from "./whale-widget"

const AVATAR_SIZE = 44
const MIN_WIDGET_SIZE = 26
const MAX_WIDGET_SIZE = 110

export interface DshWidgetImportSource {
  size?: unknown
  bubble?: unknown
}

export interface DshWidgetImportResult {
  widgetSize: number | null
  options: WhaleOptions
  warnings: string[]
}

type JsonObject = Record<string, unknown>

function objectOf(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function text(value: unknown, max = 1800): string {
  return typeof value === "string" ? value.slice(0, max) : ""
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function widgetSizeOf(scale: number | null): number {
  const multiplier = scale ?? 1
  return Math.round(
    clamp(AVATAR_SIZE * multiplier, MIN_WIDGET_SIZE, MAX_WIDGET_SIZE)
  )
}

function moduleSize(value: unknown): number | undefined {
  const size = finite(value)
  return size == null ? undefined : Math.round(clamp(size, 1, 50))
}

function hexColor(value: unknown): string | undefined {
  return typeof value === "string" && /^#[\da-f]{6}$/i.test(value)
    ? value
    : undefined
}

function weightedLines(value: unknown): string {
  if (!Array.isArray(value)) return ""
  return value
    .map((line) => {
      const item = objectOf(line)
      if (!item) return ""
      const choice = text(item.t, 1800).trim()
      if (!choice) return ""
      return `${Math.max(1, Math.round(finite(item.w) ?? 1))}|${choice}`
    })
    .filter(Boolean)
    .join("\n")
}

function translateModule(
  value: unknown,
  warn: (message: string) => void
): WhaleModule | null {
  const rawModule = objectOf(value)
  if (!rawModule) return null
  const sourceType = text(rawModule.type, 40)
  const mappedType =
    sourceType === "random"
      ? "randomText"
      : sourceType === "randimg"
        ? "randomImage"
        : sourceType === "nextpeak"
          ? "peak"
          : sourceType
  const supported = [
    "text",
    "link",
    "randomText",
    "image",
    "randomImage",
    "account",
    "balance",
    "used",
    "total",
    "today",
    "cost",
    "tokens",
    "peak",
    "session",
    "bonus",
    "recharge",
    "quota",
  ] as const
  if (!(supported as readonly string[]).includes(mappedType)) {
    warn(`不支持 DSH 模块 ${sourceType || "(unknown)"}，已跳过。`)
    return null
  }

  if (sourceType === "random") {
    if (
      Array.isArray(rawModule.lines) &&
      rawModule.lines.some((line) => {
        const item = objectOf(line)
        return (
          item != null &&
          (item.size != null ||
            item.rgb != null ||
            item.color != null ||
            item.italic != null ||
            item.ul != null)
        )
      })
    )
      warn("DSH 随机语句的行级字号/颜色不会逐行保留。")
  }
  if (sourceType === "image" || sourceType === "randimg")
    warn("DSH 图片素材未导入；导入后需要重新选择 Codeg 中的图片。")
  if (rawModule.rgb != null) warn("DSH 跑马灯渐变不会自动转换为 Codeg 颜色。")

  const converted: WhaleModule = {
    type: mappedType as WhaleModule["type"],
    value:
      sourceType === "random"
        ? weightedLines(rawModule.lines)
        : sourceType === "image" || sourceType === "randimg"
          ? text(rawModule.imgId, 1800)
          : text(rawModule.text ?? rawModule.tpl ?? rawModule.t),
  }
  const size = moduleSize(rawModule.size)
  if (size != null) converted.size = size
  const color = hexColor(rawModule.color)
  if (color) converted.color = color
  const background = hexColor(rawModule.bg)
  if (background) converted.background = background
  const font = text(rawModule.fontFamily ?? rawModule.font, 120).trim()
  if (font) converted.font = font
  if (typeof rawModule.bold === "boolean") converted.bold = rawModule.bold
  if (typeof rawModule.italic === "boolean") converted.italic = rawModule.italic
  const underline = rawModule.ul ?? rawModule.underline
  if (typeof underline === "boolean") converted.underline = underline
  const href = text(rawModule.url, 1000).trim()
  if (href) converted.href = href
  const limit = finite(rawModule.len)
  if (limit != null) converted.limit = Math.round(clamp(limit, 0, 200))
  return converted
}

function translateRows(
  value: unknown,
  warn: (message: string) => void
): WhaleBubble {
  if (!Array.isArray(value)) return []
  const rows: WhaleModule[][] = []
  let currentKey: string | null = null
  let current: WhaleModule[] | null = null
  for (const [index, item] of value.entries()) {
    const rawModule = objectOf(item)
    if (!rawModule) continue
    const converted = translateModule(rawModule, warn)
    if (!converted) continue
    const image = converted.type === "image" || converted.type === "randomImage"
    if (image) {
      rows.push([converted])
      current = null
      currentKey = null
      continue
    }
    const row = finite(rawModule.row)
    const key = row == null ? `solo:${index}` : `row:${row}`
    if (current && currentKey === key) {
      if (current.length < 6) current.push(converted)
      continue
    }
    current = [converted]
    currentKey = key
    rows.push(current)
  }
  return rows.slice(0, 6) as WhaleBubble
}

function translateItem(
  value: unknown,
  warn: (message: string) => void
): Array<{ weight: number; rows: WhaleBubble }> {
  const item = objectOf(value)
  if (!item) return []
  if (item.kind === "choice" && Array.isArray(item.options)) {
    return item.options.flatMap((choice) => {
      const option = objectOf(choice)
      const target = objectOf(option?.item)
      if (!option || !target) return []
      const rows = translateRows(target.modules, warn)
      return rows.length
        ? [
            {
              weight: Math.max(1, Math.round(finite(option.w) ?? 1)),
              rows,
            },
          ]
        : []
    })
  }
  const rows = translateRows(item.modules, warn)
  return rows.length ? [{ weight: 1, rows }] : []
}

export function translateDshWidgetImport(
  source: DshWidgetImportSource,
  current: WhaleOptions = {}
): DshWidgetImportResult {
  const warnings: string[] = []
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message)
  }
  const size = objectOf(source.size)
  const scale = finite(size?.scale)
  const bubble = objectOf(source.bubble)
  const items = Array.isArray(bubble?.items) ? bubble.items : []
  const sequence = items
    .map((item) => translateItem(item, warn))
    .filter((item) => item.length > 0)
  const next: WhaleOptions = {
    ...current,
    ...(sequence.length ? { sequence } : {}),
    ...(bubble && typeof bubble.tapAdvance === "boolean"
      ? { advanceOnAvatar: bubble.tapAdvance }
      : {}),
  }
  return {
    widgetSize: scale == null ? null : widgetSizeOf(scale),
    options: parseWhaleOptions(next),
    warnings,
  }
}

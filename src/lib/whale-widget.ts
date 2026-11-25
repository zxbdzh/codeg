import { z } from "zod"

import type { MessageTurn, WhaleBalanceSnapshot } from "./types"

export const EVENTS = [
  "press",
  "complete",
  "question",
  "permission",
  "low",
  "budget",
] as const
export const MODULE_TYPES = [
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
const color = z
  .string()
  .regex(/^#[\da-f]{6}$/i)
  .or(z.literal(""))
const media = z.object({
  id: z.string(),
  name: z.string().max(160),
  data: z
    .string()
    .regex(
      /^data:(?:image\/(?:png|gif|jpeg|webp)|audio\/(?:wav|mpeg|ogg|mp4|webm|x-wav));base64,[a-z\d+/]+=*$/i
    ),
  from: z.number().nonnegative().optional(),
  to: z.number().positive().optional(),
})
const moduleSchema = z.object({
  type: z.enum(MODULE_TYPES),
  value: z.string().max(1800),
  href: z.string().max(1000).optional(),
  size: z.number().min(10).max(48).optional(),
  color: color.optional(),
  gradient: color.optional(),
  background: color.optional(),
  font: z.string().max(120).optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  limit: z.number().int().min(0).max(200).optional(),
})
const bubbleSchema = z.array(z.array(moduleSchema).min(1).max(6)).max(6)
const eventSchema = z.object({
  enabled: z.boolean().optional(),
  sound: z.string().optional(),
  release: z.string().optional(),
  volume: z.number().min(0).max(100).optional(),
  seconds: z.number().min(0).max(3600).optional(),
  bubble: bubbleSchema.optional(),
})
const threshold = z.number().nonnegative().nullable().optional()
const optionsSchema = z.object({
  hideMenu: z.boolean().optional(),
  avoidScrollbar: z.boolean().optional(),
  hideBubble: z.boolean().optional(),
  advanceOnAvatar: z.boolean().optional(),
  role: z.string().optional(),
  assets: z.array(media).max(40).optional(),
  library: z.array(moduleSchema).max(40).optional(),
  sequence: z
    .array(
      z
        .array(
          z.object({
            weight: z.number().min(1).max(100),
            rows: bubbleSchema,
          })
        )
        .min(1)
        .max(6)
    )
    .max(24)
    .optional(),
  snap: z
    .object({
      mode: z.enum(["ratio", "pixels"]),
      left: z.number().min(0).max(1000),
      right: z.number().min(0).max(1000),
      top: z.number().min(0).max(1000),
      bottom: z.number().min(0).max(1000),
    })
    .optional(),
  events: z
    .object({
      press: eventSchema.optional(),
      complete: eventSchema.optional(),
      question: eventSchema.optional(),
      permission: eventSchema.optional(),
      low: eventSchema.optional(),
      budget: eventSchema.optional(),
    })
    .optional(),
  alerts: z
    .record(z.string(), z.object({ low: threshold, budget: threshold }))
    .optional(),
  quotas: z
    .record(
      z.string(),
      z.object({
        total: z.number().positive(),
        source: z.enum(["manual", "indexed", "codex"]),
        reset: z.enum(["never", "daily", "monthly"]),
        used: z.number().nonnegative(),
        models: z.string().max(300),
        since: z.string().optional(),
      })
    )
    .optional(),
  prices: z
    .record(
      z.string(),
      z.object({
        input: z.number().nonnegative(),
        cache: z.number().nonnegative(),
        output: z.number().nonnegative(),
        exchange: z.number().positive(),
      })
    )
    .optional(),
})

export type WhaleOptions = z.infer<typeof optionsSchema>
export type WhaleModule = z.infer<typeof moduleSchema>
export type WhaleBubble = z.infer<typeof bubbleSchema>
export type WhaleEvent = (typeof EVENTS)[number]
export type WhaleEventOptions = z.infer<typeof eventSchema>
export type WhaleAsset = z.infer<typeof media>
export type WhaleSnap = NonNullable<WhaleOptions["snap"]>

export const DEFAULT_SNAP: WhaleSnap = {
  mode: "ratio",
  left: 25,
  right: 25,
  top: 0,
  bottom: 25,
}

export function parseWhaleOptions(value: unknown): WhaleOptions {
  const result = optionsSchema.safeParse(value)
  if (!result.success) throw new Error("Invalid whale widget options")
  return result.data
}

export function snapWhalePosition(
  pos: { x: number; y: number },
  limits: { x: number; y: number },
  size: number,
  snap: WhaleSnap
) {
  const zone = (extent: number, value: number) =>
    snap.mode === "pixels"
      ? Math.min(extent, value)
      : (extent * Math.min(50, value)) / 100
  const horizontal = limits.x + size
  const vertical = limits.y + size
  const centerX = pos.x + size / 2
  const centerY = pos.y + size / 2
  const nearLeft = snap.left > 0 && centerX <= zone(horizontal, snap.left)
  const nearRight =
    snap.right > 0 && horizontal - centerX <= zone(horizontal, snap.right)
  const nearTop = snap.top > 0 && centerY <= zone(vertical, snap.top)
  const nearBottom =
    snap.bottom > 0 && vertical - centerY <= zone(vertical, snap.bottom)
  const left = nearLeft && (!nearRight || centerX <= horizontal / 2)
  const top = nearTop && (!nearBottom || centerY <= vertical / 2)
  return {
    position: {
      x: left ? 0 : nearRight ? null : pos.x,
      y: top ? 0 : nearBottom ? null : pos.y,
    },
    mirror: left ? true : nearRight ? false : undefined,
  }
}

export function weightedIndex(
  weights: number[],
  random: number,
  previous = -1
) {
  const eligible = weights.map((weight, index) =>
    index === previous && weights.length > 1 ? 0 : weight
  )
  let target = random * eligible.reduce((sum, weight) => sum + weight, 0)
  return eligible.findIndex((weight) => (target -= weight) < 0)
}

export function whaleDate(at: number | string) {
  return new Date(new Date(at).getTime() + 8 * 3600_000)
    .toISOString()
    .slice(0, 10)
}

export function whaleAlertKeys(
  snapshot: WhaleBalanceSnapshot,
  options: WhaleOptions,
  now: number
) {
  const id = snapshot.modelId ?? "default"
  const alert = options.alerts?.[id]
  if (
    !alert ||
    !snapshot.configured ||
    snapshot.stale ||
    snapshot.lastError ||
    !snapshot.lastSuccessAt
  )
    return {}
  return {
    low:
      alert.low != null &&
      snapshot.balance != null &&
      snapshot.balance < alert.low
        ? `${id}:${snapshot.accountGeneration}:${alert.low}`
        : undefined,
    budget:
      alert.budget != null &&
      snapshot.observedToday != null &&
      snapshot.observedToday >= alert.budget
        ? `${id}:${snapshot.accountGeneration}:${alert.budget}:${whaleDate(now)}`
        : undefined,
  }
}

export function whaleTurnUsage(
  turns: MessageTurn[],
  startedAt: number,
  finishedAt: number,
  settings: {
    peakPrice?: number | null
    offPeakPrice?: number | null
    currency?: string
  },
  prices?: WhaleOptions["prices"]
) {
  let latestUser = turns.length - 1
  while (latestUser >= 0 && turns[latestUser].role !== "user") latestUser--
  if (latestUser !== -1 && Date.parse(turns[latestUser].timestamp) > finishedAt)
    return null
  const usageTurns = turns.slice(latestUser + 1).filter((turn) => {
    const at = Date.parse(turn.completed_at ?? turn.timestamp)
    return (
      turn.role === "assistant" &&
      turn.usage &&
      at >= startedAt - 1000 &&
      at <= finishedAt + 1000
    )
  })
  if (!usageTurns.length) return null
  const local = new Date(finishedAt + 8 * 3600_000)
  const hour = local.getUTCHours()
  const peak =
    local.getUTCDay() % 6 !== 0 &&
    ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
  const flat = peak ? settings.peakPrice : settings.offPeakPrice
  let tokens = 0
  let cost = 0
  let priced = true
  for (const turn of usageTurns) {
    const {
      input_tokens,
      output_tokens,
      cache_creation_input_tokens,
      cache_read_input_tokens,
    } = turn.usage!
    const input = input_tokens + cache_creation_input_tokens
    // Codeg 的 TokenUsage 把缓存命中单独计价；原版模块把它并入输入会高估每轮费用。
    const total = input + output_tokens + cache_read_input_tokens
    tokens += total
    const price = turn.model ? prices?.[turn.model] : undefined
    if (price) {
      cost +=
        (input * price.input +
          output_tokens * price.output +
          cache_read_input_tokens * price.cache) *
        price.exchange
    } else if (flat != null) {
      cost += total * flat
    } else {
      priced = false
    }
  }
  // 明细单价按人民币结算，不把它与其它币种的峰谷单价相加。
  if (
    settings.currency &&
    settings.currency !== "CNY" &&
    usageTurns.some((turn) => turn.model && prices?.[turn.model])
  )
    priced = false
  return {
    tokens,
    cost: priced ? cost / 1_000_000 : null,
    currency: settings.currency ?? "CNY",
  }
}

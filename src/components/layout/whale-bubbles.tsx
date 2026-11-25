import { useMemo, type CSSProperties } from "react"

import { BrowserLink } from "@/components/ui/browser-link"
import {
  weightedIndex,
  type WhaleBubble,
  type WhaleModule,
  type WhaleOptions,
} from "@/lib/whale-widget"

export type BubbleValues = Record<string, string | undefined>

export function fillBubbleText(template: string, values: BubbleValues) {
  return template.replace(
    /\{([a-z_]+)\}/gi,
    (key, name: string) => values[name] ?? key
  )
}

export function parseChoices(text: string) {
  return text
    .split("\n")
    .map((line) => {
      const match = /^([1-9]\d?)\|(.*)$/.exec(line)
      return {
        text: (match?.[2] ?? line).trim(),
        weight: Number(match?.[1] ?? 1),
      }
    })
    .filter((choice) => choice.text)
}

export function useBubbleChoices(
  bubble: WhaleBubble | undefined,
  revision: number
) {
  // revision 相同就保持同一组随机内容，避免挂件每次重渲染都跳字。
  return useMemo(() => {
    const choices: Record<string, string> = {}
    bubble?.forEach((row, rowIndex) =>
      row.forEach((module, colIndex) => {
        if (module.type !== "randomText" && module.type !== "randomImage")
          return
        const key = `${rowIndex}-${colIndex}-${module.type}-${module.value}`
        const candidates = parseChoices(module.value)
        let seed = revision
        for (const char of key) seed = (seed * 31 + char.charCodeAt(0)) >>> 0
        const index = weightedIndex(
          candidates.map((choice) => choice.weight),
          (seed % 10_000) / 10_000
        )
        if (index >= 0) choices[key] = candidates[index].text
      })
    )
    return choices
  }, [bubble, revision])
}

function webLink(value: string) {
  try {
    const parsed = new URL(value)
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.href
      : undefined
  } catch {
    return undefined
  }
}

export function WhaleBubbleContent({
  rows,
  options,
  values,
  revision = 0,
}: {
  rows: WhaleBubble
  options: WhaleOptions
  values: BubbleValues
  revision?: number
}) {
  const choices = useBubbleChoices(rows, revision)
  return (
    <div className="grid max-w-full gap-1 text-center wrap-anywhere">
      {rows.map((row, rowIndex) => (
        <div
          key={rowIndex}
          className="flex max-w-full flex-wrap items-center justify-center gap-x-2"
        >
          {row.map((module, colIndex) => {
            const random =
              choices?.[
                `${rowIndex}-${colIndex}-${module.type}-${module.value}`
              ]
            const image =
              module.type === "image" || module.type === "randomImage"
            if (image) {
              const asset = options.assets?.find(
                (item) =>
                  item.id ===
                    (module.type === "image" ? module.value : random) &&
                  item.data.startsWith("data:image/")
              )
              return asset ? (
                <img
                  key={colIndex}
                  src={asset.data}
                  alt={asset.name}
                  className="mx-auto block max-h-24 max-w-full object-contain"
                />
              ) : null
            }
            const named = values[module.type]
            const limit = module.limit || 0
            const chars = Array.from(named ?? "")
            const truncated =
              limit > 0 && chars.length > limit
                ? `${chars.slice(0, limit).join("")}…`
                : named
            const text = fillBubbleText(
              random ?? (module.value || (truncated ?? "")),
              { ...values, [module.type]: truncated }
            )
            const href =
              module.type === "link" ? webLink(module.href ?? "") : undefined
            return (
              <span key={colIndex} style={moduleStyle(module)}>
                {href ? (
                  <BrowserLink href={href} className="underline">
                    {text}
                  </BrowserLink>
                ) : (
                  text
                )}
              </span>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function moduleStyle(module: WhaleModule): CSSProperties {
  return {
    color: module.color || undefined,
    backgroundColor: module.background || undefined,
    ...(module.gradient && {
      backgroundImage: `linear-gradient(90deg, ${module.color || "#536ba9"}, ${module.gradient})`,
      backgroundClip: "text",
      color: "transparent",
    }),
    fontFamily: module.font || undefined,
    fontSize: module.size,
    fontWeight: module.bold ? 700 : undefined,
    fontStyle: module.italic ? "italic" : undefined,
    textDecoration: module.underline ? "underline" : undefined,
  }
}

export function playWhaleSound(
  options: WhaleOptions,
  sound: string | undefined,
  volume: number
) {
  if (!sound || !volume) return () => {}
  const clip = options.assets?.find(
    (asset) => asset.id === sound && asset.data.startsWith("data:audio/")
  )
  if (clip) {
    const audio = new Audio(clip.data)
    audio.volume = volume / 100
    const stop = () => audio.pause()
    audio.addEventListener(
      "loadedmetadata",
      () => {
        audio.currentTime = clip.from ?? 0
      },
      { once: true }
    )
    audio.addEventListener("timeupdate", () => {
      if (clip.to != null && audio.currentTime >= clip.to) stop()
    })
    void audio.play().catch(() => {})
    return stop
  }
  if (!sound.startsWith("tone:") || typeof AudioContext === "undefined")
    return () => {}
  const context = new AudioContext()
  const gain = context.createGain()
  gain.gain.setValueAtTime(volume / 800, context.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.22)
  gain.connect(context.destination)
  const oscillator = context.createOscillator()
  oscillator.frequency.value = sound === "tone:low" ? 440 : 740
  oscillator.connect(gain)
  oscillator.start()
  oscillator.stop(context.currentTime + 0.24)
  const stop = () => {
    if (context.state !== "closed") void context.close().catch(() => {})
  }
  oscillator.onended = stop
  void context.resume().catch(stop)
  return stop
}

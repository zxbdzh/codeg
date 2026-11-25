import { useCallback, useEffect, useRef, useState } from "react"

import { getFolderConversation, getWhaleBalanceSettings } from "@/lib/api"
import { getTransport } from "@/lib/transport"
import type { WhaleBalanceSnapshot } from "@/lib/types"
import {
  parseWhaleOptions,
  whaleAlertKeys,
  whaleTurnUsage,
  type WhaleEvent,
  type WhaleOptions,
} from "@/lib/whale-widget"
import type { PetSessionsPayload } from "@/lib/pet/types"
import { playWhaleSound, type BubbleValues } from "./whale-bubbles"

const SEEN_KEY = "codeg.whale-widget.seen-notices"
export const DEFAULT_SECONDS = 180

interface SessionNotice {
  kind: "start" | "complete" | "question" | "permission"
  id?: string
  connectionId: string
  conversationId?: number
  seq: number
  at: number
}

function alreadySeen(key: string) {
  try {
    const seen = (
      JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as string[]
    ).slice(-199)
    if (seen.includes(key)) return true
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, key]))
  } catch {}
  return false
}

export function useWhaleOptions(
  snapshot: WhaleBalanceSnapshot | null,
  sessions: PetSessionsPayload | null
) {
  const [options, setOptions] = useState<WhaleOptions>({})
  const [loaded, setLoaded] = useState(false)
  const [notice, setNotice] = useState<{
    kind: WhaleEvent
    values: BubbleValues
    conversationId?: number
  } | null>(null)
  const current = useRef({ options, snapshot, sessions })
  useEffect(() => {
    current.current = { options, snapshot, sessions }
  }, [options, snapshot, sessions])
  const activeAlerts = useRef<Record<string, string | undefined>>({})
  const show = useCallback(
    (kind: WhaleEvent, values: BubbleValues, conversationId?: number) => {
      const config = current.current.options.events?.[kind]
      if (!config?.enabled) return
      playWhaleSound(
        current.current.options,
        config.sound,
        config.volume ?? current.current.options.events?.press?.volume ?? 100
      )
      setNotice({ kind, values, conversationId })
    },
    []
  )

  useEffect(() => {
    const transport = getTransport()
    let disposed = false
    let revision = 0
    const cleanups: (() => void)[] = []
    const starts = new Map<string, number>()
    const load = () => {
      const request = ++revision
      void Promise.resolve(transport.call("whale_widget_get_options"))
        .then((value) => {
          if (!disposed && request === revision && value != null) {
            setOptions(parseWhaleOptions(value))
            setLoaded(true)
          }
        })
        .catch(() => {})
    }
    const subscribe = <Payload>(
      channel: string,
      handler: (payload: Payload) => void
    ) => {
      void Promise.resolve(transport.subscribe<Payload>(channel, handler))
        .then((cleanup) => {
          if (!cleanup) return
          if (disposed) cleanup()
          else cleanups.push(cleanup)
        })
        .catch(() => {})
    }
    load()
    subscribe("whale://options-updated", load)
    if (transport.onReconnect) cleanups.push(transport.onReconnect(load))
    subscribe<SessionNotice>("whale://session-notice", (event) => {
      if (disposed || !current.current.snapshot?.enabled) return
      if (event.kind === "start") {
        if (starts.size >= 500) starts.clear()
        starts.set(event.connectionId, event.at)
        return
      }
      if (!current.current.options.events?.[event.kind]?.enabled) return
      const key = `${event.connectionId}:${event.kind}:${event.id ?? event.seq}`
      if (alreadySeen(key)) return
      const session = current.current.sessions?.sessions.find(
        (row) => row.connectionId === event.connectionId
      )
      if (event.kind !== "complete") {
        show(
          event.kind,
          { session: session?.title },
          event.conversationId ?? session?.conversationId
        )
        return
      }
      const start = starts.get(event.connectionId) ?? event.at - 1000
      starts.delete(event.connectionId)
      const conversationId = event.conversationId ?? session?.conversationId
      if (!conversationId) {
        show("complete", { session: session?.title })
        return
      }
      void (async () => {
        try {
          const settings = await getWhaleBalanceSettings()
          let title = session?.title
          // 部分代理先发结束事件再落盘，短暂重试，但绝不拿上一轮的用量顶替。
          for (const delay of [0, 450, 1200]) {
            if (delay)
              await new Promise((resolve) => setTimeout(resolve, delay))
            if (disposed || (starts.get(event.connectionId) ?? 0) > event.at)
              return
            const detail = await getFolderConversation(conversationId, {
              tailTurns: 64,
            })
            if (disposed) return
            title = detail.summary.title ?? title
            const usage = whaleTurnUsage(
              detail.turns,
              start,
              event.at,
              settings,
              current.current.options.prices
            )
            if (!usage) continue
            show(
              "complete",
              {
                session: title,
                tokens: usage.tokens.toLocaleString(),
                cost:
                  usage.cost == null
                    ? undefined
                    : `${usage.currency} ${usage.cost.toFixed(4)}`,
              },
              conversationId
            )
            return
          }
          if (!disposed) show("complete", { session: title }, conversationId)
        } catch {
          if (!disposed)
            show("complete", { session: session?.title }, conversationId)
        }
      })()
    })
    return () => {
      disposed = true
      cleanups.forEach((cleanup) => cleanup())
    }
  }, [show])

  useEffect(() => {
    if (
      !snapshot?.enabled ||
      !snapshot.lastSuccessAt ||
      snapshot.stale ||
      snapshot.lastError
    )
      return
    const keys = whaleAlertKeys(snapshot, options, Date.now())
    for (const kind of ["low", "budget"] as const) {
      const scope = `${kind}:${snapshot.modelId ?? "default"}`
      const key = options.events?.[kind]?.enabled ? keys[kind] : undefined
      if (
        key &&
        key !== activeAlerts.current[scope] &&
        (kind === "low" || !alreadySeen(`budget:${key}`))
      )
        show(kind, {})
      activeAlerts.current[scope] = key
    }
  }, [snapshot, options, show])

  useEffect(() => {
    if (!notice) return
    const seconds = options.events?.[notice.kind]?.seconds ?? DEFAULT_SECONDS
    if (!seconds) return
    const timer = setTimeout(() => setNotice(null), seconds * 1000)
    return () => clearTimeout(timer)
  }, [notice, options])

  const save = async (input: WhaleOptions) => {
    const saved = await getTransport().call("whale_widget_save_options", {
      input: parseWhaleOptions(input),
    })
    setOptions(parseWhaleOptions(saved))
  }
  return { options, loaded, notice, dismiss: () => setNotice(null), save }
}

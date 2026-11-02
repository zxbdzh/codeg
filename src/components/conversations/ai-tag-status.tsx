"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { getTagSuggestionStatus } from "@/lib/api"
import { subscribe } from "@/lib/platform"
import type { AiTagStatus as Status } from "@/lib/types"

export function AiTagStatus({
  conversationId,
  onOpen,
}: {
  conversationId: number
  onOpen: () => void
}) {
  const t = useTranslations("AutoTagSuggestions")
  const [status, setStatus] = useState<Status | null>(null)
  useEffect(() => {
    let disposed = false
    let stop: (() => void) | undefined
    const refresh = () => {
      void getTagSuggestionStatus(conversationId)
        .then((next) => {
          if (!disposed) setStatus(next)
        })
        .catch(() => {})
    }
    refresh()
    window.addEventListener("focus", refresh)
    void subscribe<{ conversationId: number }>("ai-tags://changed", (event) => {
      if (event.conversationId === conversationId) refresh()
    })
      .then((unsubscribe) => {
        if (disposed) unsubscribe()
        else stop = unsubscribe
      })
      .catch(() => {})
    return () => {
      disposed = true
      stop?.()
      window.removeEventListener("focus", refresh)
    }
  }, [conversationId])
  if (!status) return null
  const label = status.batch
    ? t("pending")
    : status.error
      ? t("failed")
      : status.running
        ? t("generating")
        : status.ignored.length
          ? t("ignored")
          : null
  if (!label) return null
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={onOpen}
        title={status.error ?? undefined}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        {label}
      </button>
      {status.batch && status.error && (
        <span className="text-xs text-destructive" title={status.error}>
          {t("failed")}
        </span>
      )}
    </span>
  )
}

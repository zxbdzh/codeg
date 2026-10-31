"use client"

import { useCallback, useEffect, useState } from "react"
import { create } from "zustand"
import { useTranslations } from "next-intl"
import { RefreshCw, Sparkles } from "lucide-react"
import { toast } from "sonner"
import {
  getAiAssistantAvailability,
  generateConversationTitle,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { ContextMenuItem } from "@/components/ui/context-menu"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import {
  AiTagSuggestionDialog,
  type AiTagTarget,
} from "./ai-tag-suggestion-dialog"
import type { AiAssistantAvailability } from "@/lib/types"

const useDialog = create<{ target: AiTagTarget | null }>(() => ({
  target: null,
}))
export function openAiTagSuggestions(target: AiTagTarget) {
  // 确认框快照绑定目标；切换标签页不能把旧建议贴到另一条会话。
  if (!useDialog.getState().target) useDialog.setState({ target })
}
export function AiTagSuggestionsHost() {
  const target = useDialog((s) => s.target)
  return target ? (
    <AiTagSuggestionDialog
      key={target.conversationId}
      {...target}
      onClose={() => useDialog.setState({ target: null })}
    />
  ) : null
}

// 同一帧挂载的多个入口共用一次状态查询，避免侧栏每张卡都请求后端。
let pendingAvailability: Promise<AiAssistantAvailability> | undefined
function fetchAvailability() {
  return (pendingAvailability ??= getAiAssistantAvailability().finally(() => {
    pendingAvailability = undefined
  }))
}
export function useAiAvailability() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let disposed = false
    const refresh = () => {
      void fetchAvailability()
        .then((status) => {
          if (!disposed) setReady(status === "ready")
        })
        .catch(() => {
          if (!disposed) setReady(false)
        })
    }
    refresh()
    window.addEventListener("focus", refresh)
    window.addEventListener("codeg:ai-settings-changed", refresh)
    return () => {
      disposed = true
      window.removeEventListener("focus", refresh)
      window.removeEventListener("codeg:ai-settings-changed", refresh)
    }
  }, [])
  return ready
}
export function AiTagButton(props: AiTagTarget) {
  const t = useTranslations("AiTagging")
  const ready = useAiAvailability()
  return (
    <span title={ready ? t("action") : t("unavailable")}>
      <button
        type="button"
        disabled={!ready}
        aria-label={t("action")}
        onClick={() => openAiTagSuggestions(props)}
        className="flex size-7 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-40"
      >
        <Sparkles className="size-4" />
      </button>
    </span>
  )
}
export function AiConversationMenuItems({
  conversationId,
  folderId,
  context = false,
}: AiTagTarget & { context?: boolean }) {
  const t = useTranslations("AiTagging")
  const ready = useAiAvailability()
  const [refreshing, setRefreshing] = useState(false)
  const refresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      const title = await generateConversationTitle(conversationId, true)
      toast.info(title ? t("refreshDone") : t("titleSkipped"))
    } catch (err) {
      toast.error(t("failed"), { description: toErrorMessage(err) })
    } finally {
      setRefreshing(false)
    }
  }, [conversationId, refreshing, t])
  const Item = context ? ContextMenuItem : DropdownMenuItem
  return (
    <>
      <Item
        disabled={!ready}
        title={ready ? undefined : t("unavailable")}
        onSelect={() => openAiTagSuggestions({ conversationId, folderId })}
      >
        <Sparkles className="size-4" />
        {t("action")}
      </Item>
      <Item
        disabled={!ready || refreshing}
        title={ready ? undefined : t("unavailable")}
        onSelect={() => void refresh()}
      >
        <RefreshCw className="size-4" />
        {t("refreshTitle")}
      </Item>
    </>
  )
}

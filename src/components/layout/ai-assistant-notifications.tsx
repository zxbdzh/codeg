"use client"

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import { subscribe } from "@/lib/platform"

/** 自动标题任务属于辅助功能；它失败时只提示，不污染编码会话的 ACP 错误状态。 */
export function AiAssistantNotifications() {
  const t = useTranslations("AiAssistant")
  const tSettings = useTranslations("AiAssistantSettings")

  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void subscribe<{ conversationId: number; error: unknown }>(
      "ai-assistant://error",
      ({ conversationId, error }) => {
        if (disposed) return
        const appError = extractAppCommandError(error)
        const key = appError?.i18n_key?.replace(/^aiAssistant\./, "")
        const messageKey = key as Parameters<typeof t>[0] | undefined
        const description =
          messageKey && t.has(messageKey)
            ? t(messageKey)
            : toErrorMessage(error)
        toast.error(tSettings("title"), {
          id: `ai-assistant:${conversationId}`,
          description,
        })
      }
    )
      .then((stop) => {
        // 事件订阅可能跨 IPC/WS 异步注册；卸载先到时仍要释放迟到的订阅。
        if (disposed) stop()
        else unsubscribe = stop
      })
      .catch((error: unknown) => {
        console.warn("Failed to subscribe to AI assistant notifications", error)
      })
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [t, tSettings])
  return null
}

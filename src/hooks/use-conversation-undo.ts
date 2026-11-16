"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { extractAppCommandError } from "@/lib/app-error"
import {
  undoConversation,
  type ConversationUndoResult,
} from "@/lib/conversation-undo"
import type { ForkPromptSnapshot } from "@/lib/research-branch"

interface UndoSelection {
  conversationId: number
  turnId: string
  text: string
  prompt: ForkPromptSnapshot
}

export function useConversationUndo({
  conversationId,
  busy,
  onComplete,
  onFailure,
}: {
  conversationId: number | null
  busy: boolean
  onComplete: (result: ConversationUndoResult, text: string) => Promise<void>
  onFailure: (conversationId: number) => Promise<void>
}) {
  const t = useTranslations("ConversationUndo")
  const [selection, setSelection] = useState<UndoSelection | null>(null)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const requestUndo = useCallback(
    (
      turnId: string,
      text: string,
      _fromStart?: boolean,
      prompt?: ForkPromptSnapshot
    ) => {
      if (conversationId == null || pendingRef.current) return
      if (busy) {
        toast.info(t("busy"))
        return
      }
      if (!prompt) return
      setSelection({ conversationId, turnId, text, prompt })
    },
    [busy, conversationId, t]
  )

  const cancelUndo = useCallback(() => {
    if (!pendingRef.current) setSelection(null)
  }, [])

  const confirmUndo = useCallback(async () => {
    if (!selection || pendingRef.current) return
    if (busy || selection.conversationId !== conversationId) {
      toast.info(t("busy"))
      return
    }
    pendingRef.current = true
    setPending(true)
    try {
      const result = await undoConversation({
        conversationId: selection.conversationId,
        sourceTurnId: selection.turnId,
        sourcePrompt: selection.prompt,
      })
      // 成功回退后才回填；失败时保留原输入和原历史，也不自动重试。
      await onComplete(result, selection.text)
      if (mounted.current) {
        setSelection(null)
        toast.success(t("done"))
      }
    } catch (error) {
      const commandError = extractAppCommandError(error)
      if (mounted.current) {
        if (
          selection.conversationId === conversationId &&
          commandError?.code !== "turn_in_progress"
        ) {
          try {
            await onFailure(selection.conversationId)
          } catch {
            toast.info(t("reconnectFailed"))
          }
        }
        toast.error(
          t(commandError?.code === "turn_in_progress" ? "busy" : "failed")
        )
        setSelection(null)
      }
    } finally {
      pendingRef.current = false
      if (mounted.current) setPending(false)
    }
  }, [busy, conversationId, onComplete, onFailure, selection, t])

  return { selection, pending, requestUndo, cancelUndo, confirmUndo }
}

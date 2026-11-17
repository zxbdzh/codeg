"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  extractAppCommandError,
  toLocalizedErrorMessage,
} from "@/lib/app-error"
import {
  undoConversation,
  previewConversationUndo,
  type ConversationUndoPreview,
  type ConversationUndoResult,
  type PreparedConversationUndoRequest,
} from "@/lib/conversation-undo"
import type { ForkPromptSnapshot } from "@/lib/research-branch"
import type { MessageTurn, PromptStashSnapshot } from "@/lib/types"

interface UndoSelection {
  conversationId: number
  turnId: string
  text: string
  prompt: ForkPromptSnapshot
  preview: ConversationUndoPreview
}

export interface ConversationUndoBackend {
  preview: (request: {
    conversationId: number
    sourceTurnId: string
  }) => Promise<ConversationUndoPreview>
  commit?: (
    request: PreparedConversationUndoRequest
  ) => Promise<ConversationUndoResult>
}

const defaultBackend: ConversationUndoBackend = {
  preview: previewConversationUndo,
}

export function useConversationUndo({
  conversationId,
  busy,
  onComplete,
  onFailure,
  backend = defaultBackend,
  captureDraft,
  onSettled,
  blocked = false,
}: {
  conversationId: number | null
  busy: boolean
  blocked?: boolean
  onComplete: (
    result: ConversationUndoResult,
    text: string,
    original?: MessageTurn
  ) => Promise<void>
  onFailure: (conversationId: number) => Promise<void>
  backend?: ConversationUndoBackend
  captureDraft?: () => PromptStashSnapshot | null
  onSettled?: () => void
}) {
  const t = useTranslations("ConversationUndo")
  const [selection, setSelection] = useState<UndoSelection | null>(null)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const mounted = useRef(true)
  const currentConversation = useRef(conversationId)
  currentConversation.current = conversationId
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const describeError = useCallback(
    (error: unknown) =>
      toLocalizedErrorMessage(error, (key) =>
        key === "historyChanged" ? t("historyChanged") : key
      ),
    [t]
  )

  const requestUndo = useCallback(
    async (
      turnId: string,
      text: string,
      _fromStart?: boolean,
      prompt?: ForkPromptSnapshot
    ) => {
      if (conversationId == null || pendingRef.current) return
      if (blocked || (busy && !backend.commit)) {
        toast.info(t("busy"))
        return
      }
      if (!prompt) return
      pendingRef.current = true
      setPending(true)
      try {
        const preview = await backend.preview({
          conversationId,
          sourceTurnId: turnId,
        })
        // 切换会话后到达的旧预览不能打开新会话的确认框。
        if (!mounted.current || currentConversation.current !== conversationId)
          return
        setSelection({ conversationId, turnId, text, prompt, preview })
      } catch (error) {
        if (mounted.current)
          toast.error(t("failed"), {
            description: describeError(error),
          })
      } finally {
        pendingRef.current = false
        if (mounted.current) setPending(false)
      }
    },
    [backend, blocked, busy, conversationId, describeError, t]
  )

  const cancelUndo = useCallback(() => {
    if (!pendingRef.current) setSelection(null)
  }, [])

  const confirmUndo = useCallback(async () => {
    if (!selection || pendingRef.current) return
    if (
      blocked ||
      (busy && !backend.commit) ||
      selection.conversationId !== conversationId
    ) {
      toast.info(t("busy"))
      return
    }
    pendingRef.current = true
    setPending(true)
    try {
      const result = backend.commit
        ? await backend.commit({
            conversationId: selection.conversationId,
            sourceTurnId: selection.turnId,
            historyRevision: selection.preview.historyRevision,
            currentDraft: captureDraft?.() ?? null,
            stopConfirmed: true,
          })
        : await undoConversation({
            conversationId: selection.conversationId,
            sourceTurnId: selection.turnId,
            sourcePrompt: selection.prompt,
          })
      // 成功回退后才回填；失败时保留原输入和原历史，也不自动重试。
      if (result.prompt) {
        await onComplete(
          result,
          result.prompt.blocks
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n"),
          result.prompt
        )
      } else {
        await onComplete(result, selection.text)
      }
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
          t(commandError?.code === "turn_in_progress" ? "busy" : "failed"),
          { description: describeError(error) }
        )
        setSelection(null)
      }
    } finally {
      pendingRef.current = false
      onSettled?.()
      if (mounted.current) setPending(false)
    }
  }, [
    backend,
    blocked,
    busy,
    captureDraft,
    conversationId,
    describeError,
    onComplete,
    onFailure,
    onSettled,
    selection,
    t,
  ])

  return { selection, pending, requestUndo, cancelUndo, confirmUndo }
}

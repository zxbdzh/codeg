"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { toErrorMessage } from "@/lib/app-error"
import {
  clearConversationRedo,
  readConversationRedoStatus,
  redoConversation,
  type ConversationRedoStatus,
  type ConversationUndoResult,
} from "@/lib/conversation-undo"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

export interface ConversationRedoBackend {
  status: (conversationId: number) => Promise<ConversationRedoStatus>
  restore: (conversationId: number) => Promise<ConversationUndoResult>
  clear: (conversationId: number) => Promise<void>
}

const defaultBackend: ConversationRedoBackend = {
  status: readConversationRedoStatus,
  restore: redoConversation,
  clear: clearConversationRedo,
}

export function ConversationRedoControl({
  conversationId,
  revision,
  busy,
  onRestored,
  backend = defaultBackend,
}: {
  conversationId: number
  revision: number | string
  busy: boolean
  onRestored: (result: ConversationUndoResult) => Promise<void>
  backend?: ConversationRedoBackend
}) {
  const t = useTranslations("ConversationUndo")
  const [status, setStatus] = useState<ConversationRedoStatus | null>(null)
  const [statusRevision, setStatusRevision] = useState<typeof revision | null>(
    null
  )
  const [confirmClear, setConfirmClear] = useState(false)
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const readGeneration = useRef(0)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const refresh = useCallback(async () => {
    const generation = ++readGeneration.current
    try {
      const next = await backend.status(conversationId)
      if (mounted.current && generation === readGeneration.current) {
        setStatus(next)
        setStatusRevision(revision)
      }
    } catch {
      if (mounted.current && generation === readGeneration.current)
        setStatus(null)
    }
  }, [backend, conversationId, revision])
  useEffect(() => {
    void refresh()
  }, [refresh, revision])
  useEffect(() => {
    if (!status?.expiresAt) return
    const expires = Date.parse(status.expiresAt)
    if (!Number.isFinite(expires)) return
    const timer = window.setTimeout(
      () => void refresh(),
      Math.max(0, expires - Date.now()) + 100
    )
    return () => window.clearTimeout(timer)
  }, [refresh, status?.expiresAt])

  const run = async (operation: "restore" | "clear") => {
    if (inFlight.current || busy) return
    if (operation === "restore" && statusRevision !== revision) return
    inFlight.current = true
    setPending(true)
    try {
      if (operation === "restore") {
        const result = await backend.restore(conversationId)
        // 恢复历史不触碰输入框，用户在 Undo 后编辑的草稿继续保留。
        if (mounted.current) await onRestored(result)
      } else {
        await backend.clear(conversationId)
      }
      if (mounted.current) {
        setConfirmClear(false)
        toast.success(t(operation === "restore" ? "redoDone" : "redoCleared"))
        await refresh()
      }
    } catch (error) {
      if (mounted.current) {
        toast.error(t("redoFailed"), { description: toErrorMessage(error) })
      }
    } finally {
      inFlight.current = false
      if (mounted.current) setPending(false)
    }
  }

  if (!status?.hasBackup) return null
  return (
    <div className="flex items-center justify-end gap-1 px-3 py-1">
      <Button
        variant="ghost"
        size="sm"
        className="min-h-11 sm:min-h-7"
        disabled={
          !status.available || statusRevision !== revision || pending || busy
        }
        onClick={() => void run("restore")}
      >
        {t("redo")}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="min-h-11 sm:min-h-7"
        disabled={pending || busy}
        onClick={() => setConfirmClear(true)}
      >
        {t("clearRedo")}
      </Button>
      <AlertDialog
        open={confirmClear}
        onOpenChange={(open) => {
          if (!inFlight.current) setConfirmClear(open)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("clearRedoTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("clearRedoDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setConfirmClear(false)}
            >
              {t("cancel")}
            </Button>
            <Button disabled={pending} onClick={() => void run("clear")}>
              {t("clearRedo")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

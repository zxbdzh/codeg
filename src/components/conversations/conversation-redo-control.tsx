"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Ellipsis, Loader2, Redo2, Trash2 } from "lucide-react"
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
        if (mounted.current) {
          try {
            await onRestored(result)
          } catch {
            // 历史已经恢复，后续重连失败不能被误报为 Redo 失败，也不能保留失效的恢复入口。
            if (mounted.current) toast.info(t("redoReconnectFailed"))
          }
        }
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
    // 只保留操作本身：状态已在确认框里说明，行内再写一遍只会多占输入框上方一行。
    <div className="flex min-w-0 items-center justify-end gap-1 py-1 text-xs text-muted-foreground">
      {status.available && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 rounded-md px-2 text-xs text-foreground"
          aria-label={t("redo")}
          title={t("redo")}
          disabled={statusRevision !== revision || pending || busy}
          onClick={() => void run("restore")}
        >
          {pending ? (
            <Loader2
              aria-hidden="true"
              className="size-3.5 animate-spin motion-reduce:animate-none"
            />
          ) : (
            <Redo2 aria-hidden="true" className="size-3.5" />
          )}
          {t("redoShort")}
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-md"
            aria-label={t("redoOptions")}
            title={t("redoOptions")}
            disabled={pending || busy}
          >
            <Ellipsis aria-hidden="true" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side="top"
          className="w-auto min-w-44 rounded-lg"
        >
          <DropdownMenuItem
            variant="destructive"
            className="rounded-md text-xs"
            onSelect={() => setConfirmClear(true)}
          >
            <Trash2 aria-hidden="true" className="size-3.5" />
            {t("clearRedo")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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

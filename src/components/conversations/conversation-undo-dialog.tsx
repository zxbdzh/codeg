"use client"

import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import type { ConversationUndoPreview } from "@/lib/conversation-undo"

export function ConversationUndoDialog({
  open,
  pending,
  onCancel,
  onConfirm,
  preview,
}: {
  open: boolean
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
  preview?: ConversationUndoPreview | null
}) {
  const t = useTranslations("ConversationUndo")
  return (
    <AlertDialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onCancel()
      }}
    >
      <AlertDialogContent size="sm" aria-busy={pending}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("description")}</AlertDialogDescription>
        </AlertDialogHeader>
        {preview && (
          <div className="space-y-2 text-sm">
            <p className="font-medium">
              {t("range", {
                users: preview.affectedUserMessages,
                turns: preview.affectedTurns,
              })}
            </p>
            <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground">
              {preview.prompt.blocks
                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                .join("\n")}
            </p>
          </div>
        )}
        {Boolean(preview?.issues?.length) && (
          <div role="alert" className="space-y-2 text-sm text-destructive">
            <p>{t("inputUnavailable")}</p>
            <ul className="list-disc space-y-1 pl-5">
              {preview?.issues?.map((issue, index) => (
                <li key={`${issue.code}:${index}`} className="break-words">
                  {issue.label}
                </li>
              ))}
            </ul>
          </div>
        )}
        {Boolean(preview?.tasks?.length) && (
          <div className="space-y-2 text-sm">
            <p>{t("tasksToStop")}</p>
            <ul className="max-h-32 list-disc space-y-1 overflow-y-auto pl-5 text-muted-foreground">
              {preview?.tasks?.map((task) => (
                <li key={task.id} className="break-words">
                  {task.label ||
                    t(
                      task.kind === "turn" ? "runningTurn" : "runningBackground"
                    )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <AlertDialogFooter>
          <Button variant="outline" disabled={pending} onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button
            disabled={pending || Boolean(preview?.issues?.length)}
            onClick={onConfirm}
          >
            {pending && (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            )}
            {t(
              pending
                ? "pending"
                : preview?.tasks?.length
                  ? "confirmStop"
                  : "confirm"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

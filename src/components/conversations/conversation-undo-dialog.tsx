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

export function ConversationUndoDialog({
  open,
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
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
        <AlertDialogFooter>
          <Button variant="outline" disabled={pending} onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button disabled={pending} onClick={onConfirm}>
            {pending && (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            )}
            {t(pending ? "pending" : "confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

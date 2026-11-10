"use client"

import { useEffect } from "react"
import { Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"

export function ConversationForkProgress({ open }: { open: boolean }) {
  const t = useTranslations("ResearchBranch")

  useEffect(() => {
    if (!open) return
    // 弹窗之外还有全局快捷键和拖放入口，必须在捕获阶段拦截，避免切走创建中的来源。
    const blockInteraction = (event: Event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const events = [
      "keydown",
      "pointerdown",
      "click",
      "contextmenu",
      "drop",
    ] as const
    for (const event of events)
      window.addEventListener(event, blockInteraction, true)
    return () => {
      for (const event of events)
        window.removeEventListener(event, blockInteraction, true)
    }
  }, [open])

  return (
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        className="max-w-sm gap-3 rounded-lg p-5"
        aria-busy="true"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex items-start gap-3" role="status">
          <Loader2
            className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
            aria-hidden="true"
          />
          <div className="space-y-1.5">
            <DialogTitle className="text-[15px]">{t("forking")}</DialogTitle>
            <DialogDescription className="text-[13px]">
              {t("forkingHelp")}
            </DialogDescription>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

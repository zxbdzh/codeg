"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Bookmark } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { listPromptStash, restorePromptStash, savePromptStash } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { matchShortcutEvent } from "@/lib/keyboard-shortcuts"
import type { PromptStashEntry, PromptStashSnapshot } from "@/lib/types"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

export function PromptStashControl({
  capture,
  clearIfUnchanged,
  restoreIfEmpty,
  anchor,
  shortcut,
  pending,
}: {
  capture: () => PromptStashSnapshot | null
  clearIfUnchanged: (snapshot: PromptStashSnapshot) => void
  restoreIfEmpty: (snapshot: PromptStashSnapshot) => boolean
  anchor: React.RefObject<HTMLElement | null>
  shortcut: string
  pending: boolean
}) {
  const t = useTranslations("PromptStash")
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<PromptStashEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const latest = useRef({ capture, clearIfUnchanged, restoreIfEmpty })
  latest.current = { capture, clearIfUnchanged, restoreIfEmpty }
  const act = useCallback(
    async (event?: React.MouseEvent<HTMLButtonElement>) => {
      if (inFlight.current || pending) return
      const snapshot = latest.current.capture()
      if (snapshot) event?.preventDefault()
      inFlight.current = true
      setBusy(true)
      setError(null)
      try {
        if (snapshot) {
          await savePromptStash(snapshot)
          // 回调由宿主检查 editor 身份、草稿 key 与整个快照；复制期间新输入不丢失。
          latest.current.clearIfUnchanged(snapshot)
          toast.success(t("saved"))
          setOpen(false)
        } else {
          setOpen(true)
          setEntries(await listPromptStash())
        }
      } catch (err) {
        setError(toErrorMessage(err))
        toast.error(t("failed"), { description: toErrorMessage(err) })
      } finally {
        setBusy(false)
        inFlight.current = false
      }
    },
    [pending, t]
  )
  useEffect(() => {
    if (!shortcut) return
    const listener = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        event.repeat ||
        !matchShortcutEvent(event, shortcut)
      )
        return
      // Keep-alive 页可能同时挂多个输入框，只有焦点所在的实例消费快捷键。
      if (!anchor.current?.contains(document.activeElement)) return
      event.preventDefault()
      event.stopPropagation()
      void act()
    }
    document.addEventListener("keydown", listener, true)
    return () => document.removeEventListener("keydown", listener, true)
  }, [act, anchor, shortcut])
  const restore = async (id: number) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const snapshot = await restorePromptStash(id)
      if (!latest.current.restoreIfEmpty(snapshot)) {
        toast.info(t("inputChanged"))
        return
      }
      setOpen(false)
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("action")}
          title={t("action")}
          disabled={busy || pending}
          onClick={(event) => {
            void act(event)
          }}
        >
          <Bookmark className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-80 w-80 overflow-y-auto">
        <p className="mb-2 text-sm font-medium">{t("title")}</p>
        {busy && <p role="status">{t("loading")}</p>}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
            <Button variant="link" onClick={() => void act()}>
              {t("retry")}
            </Button>
          </p>
        )}
        {!busy && !error && !entries.length && (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        )}
        {entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            disabled={busy}
            className="block w-full rounded p-2 text-left hover:bg-accent"
            onClick={() => void restore(entry.id)}
          >
            <span className="block truncate text-sm">
              {entry.preview || t("attachmentOnly")}
            </span>
            <span className="text-xs text-muted-foreground">
              {new Date(entry.updatedAt).toLocaleString()} ·{" "}
              {t("attachments", { count: entry.attachmentCount })}
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

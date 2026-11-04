"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Bookmark, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  listPromptStash,
  removePromptStash,
  restorePromptStash,
  savePromptStash,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { matchShortcutEvent } from "@/lib/keyboard-shortcuts"
import type { PromptStashEntry, PromptStashSnapshot } from "@/lib/types"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
  // 待确认删除的那一条；null 表示没有弹窗（确认后才真正删）。
  const [pendingDelete, setPendingDelete] = useState<PromptStashEntry | null>(
    null
  )
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

  /** 取用一条：回填成功即视为消费，把它从列表与后端一起删掉。 */
  const restore = async (entry: PromptStashEntry) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const snapshot = await restorePromptStash(entry.id)
      // 输入框已有内容时放弃回填，此时模板原样保留。
      if (!latest.current.restoreIfEmpty(snapshot)) {
        toast.info(t("inputChanged"))
        return
      }
      setEntries((current) => current.filter((item) => item.id !== entry.id))
      try {
        await removePromptStash(entry.id)
      } catch (err) {
        // 回填已经生效，删除失败只提示，不把内容收回去。
        toast.error(t("deleteFailed"), { description: toErrorMessage(err) })
      }
      setOpen(false)
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const confirmDelete = async () => {
    const entry = pendingDelete
    if (!entry || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await removePromptStash(entry.id)
      setEntries((current) => current.filter((item) => item.id !== entry.id))
      toast.success(t("deleted"))
    } catch (err) {
      toast.error(t("deleteFailed"), { description: toErrorMessage(err) })
    } finally {
      setPendingDelete(null)
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          // 确认删除的弹窗盖在面板之上，别让它把面板一起关掉。
          if (!next && pendingDelete) return
          setOpen(next)
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            // 与输入框左侧的「+」按钮保持同尺寸，避免底部操作行错位。
            size="icon-xs"
            className="shrink-0 text-muted-foreground"
            aria-label={t("action")}
            title={t("action")}
            // 面板打开时不锁按钮，否则 Radix 会丢掉锚点导致面板错位。
            disabled={!open && (busy || pending)}
            onClick={(event) => {
              void act(event)
            }}
          >
            <Bookmark className="size-4" />
          </Button>
        </PopoverTrigger>
        {/* 固定在触发按钮上方展开：输入框贴着窗口底部，向下会溢出并被翻转，
            那正是此前“位置漂移”的表现。 */}
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="max-h-80 w-80 overflow-y-auto p-2"
        >
          <p className="mb-2 px-1 text-sm font-medium">{t("title")}</p>
          {busy && <p role="status">{t("loading")}</p>}
          {error && (
            <p role="alert" className="px-1 text-sm text-destructive">
              {error}
              <Button variant="link" onClick={() => void act()}>
                {t("retry")}
              </Button>
            </p>
          )}
          {!busy && !error && !entries.length && (
            <p className="px-1 text-sm text-muted-foreground">{t("empty")}</p>
          )}
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="group relative flex items-start rounded hover:bg-accent"
            >
              <button
                type="button"
                disabled={busy}
                className="min-w-0 flex-1 rounded p-2 pr-9 text-left"
                onClick={() => void restore(entry)}
              >
                <span className="block truncate text-sm">
                  {entry.preview || t("attachmentOnly")}
                </span>
                <span className="text-xs text-muted-foreground">
                  {new Date(entry.updatedAt).toLocaleString()} ·{" "}
                  {t("attachments", { count: entry.attachmentCount })}
                </span>
              </button>
              <button
                type="button"
                aria-label={t("delete")}
                title={t("delete")}
                disabled={busy}
                onClick={(event) => {
                  // 删除是独立动作，不能顺带触发整行的“取用”。
                  event.stopPropagation()
                  setPendingDelete(entry)
                }}
                className="absolute top-1 right-1 flex size-6 items-center justify-center rounded text-muted-foreground opacity-60 hover:text-destructive group-hover:opacity-100"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </PopoverContent>
      </Popover>
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.preview || t("attachmentOnly")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>
              {t("deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

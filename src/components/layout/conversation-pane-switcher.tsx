"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Layers2, Pencil, Plus, Trash2 } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { useTranslations } from "next-intl"
import { useTabStore } from "@/stores/tab-store"
import {
  buildConversationDraftStorageKey,
  buildNewConversationDraftStorageKey,
  hasLiveComposerContent,
  loadMessageInputDraftV2,
} from "@/lib/message-input-draft"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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

export function ConversationPaneSwitcher() {
  const t = useTranslations("ConversationPanes")
  const paneState = useTabStore((state) => state.paneState)
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [removing, setRemoving] = useState<string | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const compactContent = useRef<HTMLButtonElement>(null)
  const expandedContent = useRef<HTMLDivElement>(null)
  const [widths, setWidths] = useState({ compact: 88, expanded: 88 })
  const reduceMotion = useReducedMotion()
  const restoringFocus = useRef(false)
  const focusTriggerOnClose = useRef(false)
  const focusTabOnOpen = useRef(false)
  const hasPanes = paneState != null

  useLayoutEffect(() => {
    const host = container.current
    const compact = compactContent.current
    const content = expandedContent.current
    if (!host || !compact || !content) return
    const measure = () => {
      const available = host.clientWidth || 320
      const next = {
        compact: Math.min(compact.offsetWidth + 2, available),
        expanded: Math.min(content.scrollWidth + 2, available),
      }
      setWidths((previous) =>
        previous.compact === next.compact && previous.expanded === next.expanded
          ? previous
          : next
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    observer.observe(compact)
    observer.observe(content)
    return () => observer.disconnect()
  }, [hasPanes])

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const reveal = () => {
    cancelClose()
    setExpanded(true)
  }
  const deferClose = () => {
    cancelClose()
    closeTimer.current = setTimeout(() => setExpanded(false), 280)
  }

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current)
    },
    []
  )

  useEffect(() => {
    if (!expanded) return
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        container.current?.contains(event.target)
      ) {
        return
      }
      setExpanded(false)
    }
    document.addEventListener("pointerdown", dismiss)
    return () => document.removeEventListener("pointerdown", dismiss)
  }, [expanded])

  const open = expanded || menuOpen || renaming != null || removing != null
  useEffect(() => {
    const trigger = container.current?.querySelector<HTMLButtonElement>(
      "[data-pane-trigger]"
    )
    if (
      open &&
      (focusTabOnOpen.current || document.activeElement === trigger)
    ) {
      focusTabOnOpen.current = false
      container.current
        ?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
        ?.focus()
    } else if (!open && focusTriggerOnClose.current) {
      // 收起后焦点回到仍可见的小胶囊，避免留在被隐藏的标签上。
      restoringFocus.current = true
      trigger?.focus()
      restoringFocus.current = false
      focusTriggerOnClose.current = false
    }
  }, [open])

  if (!paneState) return null
  const active = paneState.panes.find(
    (pane) => pane.id === paneState.activePaneId
  )
  if (!active) return null

  const requestRemove = (paneId: string) => {
    const state = useTabStore.getState()
    const pane = state.paneState?.panes.find((item) => item.id === paneId)
    if (!pane || state.paneState!.panes.length <= 1) return
    const hasContent = state.rawTabs.some((tab) => {
      if (!Object.prototype.hasOwnProperty.call(pane.assignments, tab.id))
        return false
      const key =
        tab.conversationId == null
          ? buildNewConversationDraftStorageKey(tab.id)
          : buildConversationDraftStorageKey(tab.conversationId)
      return hasLiveComposerContent(key) || loadMessageInputDraftV2(key) != null
    })
    if (hasContent) setRemoving(paneId)
    else state.removePane(paneId)
  }

  return (
    <>
      <div
        ref={container}
        data-conversation-pane-switcher
        className="pointer-events-none absolute inset-x-6 top-0 z-40 flex justify-center"
        onPointerEnter={reveal}
        onPointerLeave={deferClose}
        onFocusCapture={(event) => {
          if (restoringFocus.current) return
          // inert 会让浏览器先移走焦点，因此在切换内容层之前记住键盘展开的来源。
          if (event.target.hasAttribute("data-pane-trigger")) {
            focusTabOnOpen.current = true
          }
          reveal()
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) deferClose()
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            cancelClose()
            focusTriggerOnClose.current = true
            setExpanded(false)
            event.stopPropagation()
          }
        }}
      >
        <motion.div
          data-pane-surface
          initial={false}
          animate={{
            width: open ? widths.expanded : widths.compact,
            height: open ? 34 : 22,
            borderRadius: open ? 17 : 11,
          }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : { type: "spring", stiffness: 520, damping: 46, mass: 1 }
          }
          className="pointer-events-auto relative mt-0.5 max-w-full overflow-hidden border border-border/70 bg-background/95 shadow-sm"
        >
          {/* 只改变外壳的真实尺寸；两层内容按原字号交接，避免布局缩放把文字和圆角拉扁。 */}
          <motion.button
            ref={compactContent}
            type="button"
            data-pane-trigger
            aria-hidden={open}
            inert={open}
            tabIndex={open ? -1 : 0}
            initial={false}
            animate={{ opacity: open ? 0 : 1 }}
            transition={{ duration: reduceMotion ? 0 : 0.1 }}
            onClick={reveal}
            aria-label={`${t("label")}: ${active.name}`}
            aria-expanded={open}
            className={cn(
              "absolute left-1/2 top-0 flex h-5 w-max max-w-36 -translate-x-1/2 items-center gap-1.5 px-2.5 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              open && "pointer-events-none"
            )}
          >
            <Layers2 className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate">{active.name}</span>
          </motion.button>
          <motion.div
            data-pane-expanded
            aria-hidden={!open}
            inert={!open}
            initial={false}
            animate={{ opacity: open ? 1 : 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.14 }}
            style={{ width: Math.max(0, widths.expanded - 2) }}
            className={cn(
              "absolute left-1/2 top-0 -translate-x-1/2 overflow-x-auto overscroll-contain",
              !open && "pointer-events-none"
            )}
          >
            <div
              ref={expandedContent}
              role="tablist"
              aria-label={t("label")}
              onKeyDown={(event) => {
                const keys = ["ArrowLeft", "ArrowRight", "Home", "End"]
                if (!keys.includes(event.key)) return
                event.preventDefault()
                const index = paneState.panes.findIndex(
                  (pane) => pane.id === active.id
                )
                const targetIndex =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? paneState.panes.length - 1
                      : (index +
                          (event.key === "ArrowLeft" ? -1 : 1) +
                          paneState.panes.length) %
                        paneState.panes.length
                const target = paneState.panes[targetIndex]
                useTabStore.getState().switchPane(target.id)
                const buttons =
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    '[role="tab"]'
                  )
                buttons[targetIndex]?.focus()
              }}
              className="flex h-8 w-max items-center gap-0.5 p-0.5"
            >
              {paneState.panes.map((pane) => (
                <ContextMenu key={pane.id} onOpenChange={setMenuOpen}>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={pane.id === active.id}
                      tabIndex={pane.id === active.id ? 0 : -1}
                      title={pane.name}
                      onClick={() => useTabStore.getState().switchPane(pane.id)}
                      className={cn(
                        "h-7 max-w-40 shrink-0 truncate rounded-full px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        pane.id === active.id
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                      )}
                    >
                      {pane.name}
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem
                      onSelect={() => {
                        setName(pane.name)
                        setRenaming(pane.id)
                      }}
                    >
                      <Pencil className="size-4" />
                      {t("rename")}
                    </ContextMenuItem>
                    <ContextMenuItem
                      disabled={paneState.panes.length <= 1}
                      onSelect={() => requestRemove(pane.id)}
                    >
                      <Trash2 className="size-4" />
                      {t("remove")}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              ))}
              <button
                type="button"
                aria-label={t("create")}
                title={t("create")}
                disabled={paneState.panes.length >= 64}
                onClick={() => useTabStore.getState().createPane()}
                className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-40"
              >
                <Plus className="size-3.5" />
              </button>
            </div>
          </motion.div>
        </motion.div>
      </div>
      <Dialog
        open={renaming != null}
        onOpenChange={(value) => {
          if (!value) setRenaming(null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (!renaming || !name.trim()) return
              useTabStore.getState().renamePane(renaming, name)
              setRenaming(null)
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("rename")}</DialogTitle>
            </DialogHeader>
            <Input
              autoFocus
              aria-label={t("name")}
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              className="my-4"
            />
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setRenaming(null)}
              >
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={!name.trim()}>
                {t("save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={removing != null}
        onOpenChange={(value) => {
          if (!value) setRemoving(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeDraftTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("removeDraftDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (removing) useTabStore.getState().removePane(removing)
                setRemoving(null)
              }}
            >
              {t("remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

"use client"

import { useEffect, useState } from "react"
import { ListChecks, Loader2, Sparkles } from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { extractAppCommandError } from "@/lib/app-error"
import { MAX_TAG_NAME_LENGTH } from "@/lib/conversation-tags"
import {
  requestTagCuration,
  type CurationChoice,
  type CurationItem,
  type CurationJob,
} from "@/lib/tag-curation"
import type { TagDimension } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useConversationTagsStore } from "@/stores/conversation-tags-store"

const selectClass =
  "h-8 min-w-0 rounded-md border border-input bg-background px-2 text-sm"

function requiresManualConfirmation(item: CurationItem) {
  return (
    ["merge", "delete", "remove"].includes(item.change.kind) &&
    item.affected.some((conversation) => conversation.manual)
  )
}

function requiresDeleteConfirmation(item: CurationItem) {
  return item.change.kind === "delete" && item.affected.length > 0
}

function itemName(item: CurationItem) {
  return item.change.kind === "create"
    ? item.change.name
    : (item.before?.name ?? item.target?.name ?? `#${item.change.tagId}`)
}

function Color({ color }: { color: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="size-2.5 rounded-full border"
        style={{ backgroundColor: color }}
      />
      {color}
    </span>
  )
}

function ChangeSummary({ item }: { item: CurationItem }) {
  const t = useTranslations("TagCuration")
  const folders = useAppWorkspaceStore((store) => store.allFolders)
  const { change, before, target, affected } = item
  const scope =
    change.kind === "create" ? change.folderId : (before ?? target)?.folder_id
  const folder = folders.find((folder) => folder.id === scope)
  return (
    <div className="grid min-w-0 gap-2 text-xs">
      <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
        <span>
          {scope == null
            ? t("global")
            : folder?.alias || folder?.name || t("folder", { id: scope })}
        </span>
        {change.kind === "create" && (
          <>
            <span className="rounded-full bg-muted/70 px-2 py-0.5">
              {t(change.dimension)}
            </span>
            <span className="rounded-full bg-muted/70 px-2 py-0.5">
              <Color color={change.color} />
            </span>
          </>
        )}
        {change.kind === "update" && (
          <>
            {change.name && (
              <span className="rounded-full bg-muted/70 px-2 py-0.5">
                {before?.name} → {change.name}
              </span>
            )}
            {change.dimension && (
              <span className="rounded-full bg-muted/70 px-2 py-0.5">
                {t(before?.dimension ?? "unclassified")} → {t(change.dimension)}
              </span>
            )}
            {change.color && before && (
              <span className="flex items-center gap-1 rounded-full bg-muted/70 px-2 py-0.5">
                <Color color={before.color} /> → <Color color={change.color} />
              </span>
            )}
          </>
        )}
        {change.kind === "merge" && (
          <span className="rounded-full bg-muted/70 px-2 py-0.5">
            {t("mergeInto", { name: target?.name ?? `#${change.targetId}` })}
          </span>
        )}
      </div>
      {affected.length > 0 && (
        <details className="rounded-lg border border-border/60 bg-muted/20 px-2.5 py-1.5">
          <summary className="cursor-pointer list-none text-muted-foreground marker:hidden">
            {t("affected", { count: affected.length })}
          </summary>
          <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto border-t border-border/50 pt-2">
            {affected.map((session) => (
              <li key={session.id} className="break-words text-foreground/80">
                {session.title || t("session", { id: session.id })}
                {session.manual && (
                  <span className="ml-2 rounded-full bg-background/70 px-1.5 py-0.5 text-muted-foreground">
                    {t("manual")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function ReviewFields({
  item,
  choice,
  onChange,
}: {
  item: CurationItem
  choice: CurationChoice
  onChange: (patch: Partial<CurationChoice>) => void
}) {
  const t = useTranslations("TagCuration")
  const tags = useConversationTagsStore((store) => store.tags)
  const { change, before } = item
  return (
    <div className="grid gap-3 rounded-lg border border-border/60 bg-muted/20 p-3">
      {(change.kind === "create" || change.kind === "update") && (
        <div className="flex flex-wrap items-end gap-3">
          {(change.kind === "create" || before?.is_protected === false) && (
            <>
              <label className="grid min-w-40 flex-1 gap-1.5 text-xs">
                {t("name")}
                <Input
                  value={choice.name ?? change.name ?? before?.name ?? ""}
                  maxLength={MAX_TAG_NAME_LENGTH}
                  onChange={(event) => onChange({ name: event.target.value })}
                />
              </label>
              <label className="grid gap-1.5 text-xs">
                {t("color")}
                <Input
                  type="color"
                  className="h-8 w-14 px-1"
                  value={
                    choice.color ?? change.color ?? before?.color ?? "#0969da"
                  }
                  onChange={(event) => onChange({ color: event.target.value })}
                />
              </label>
            </>
          )}
          <label className="grid gap-1.5 text-xs">
            {t("dimension")}
            <select
              className={selectClass}
              value={
                choice.dimension ?? change.dimension ?? before?.dimension ?? ""
              }
              onChange={(event) =>
                onChange({ dimension: event.target.value as TagDimension })
              }
            >
              <option value="" disabled>
                {t("unclassified")}
              </option>
              <option value="theme">{t("theme")}</option>
              <option value="action">{t("action")}</option>
            </select>
          </label>
        </div>
      )}
      {change.kind === "merge" && (
        <label className="grid gap-1.5 text-xs">
          {t("target")}
          <select
            className={selectClass}
            value={choice.targetId ?? change.targetId}
            onChange={(event) =>
              onChange({ targetId: Number(event.target.value) })
            }
          >
            {!tags.some((tag) => tag.id === change.targetId) && (
              <option value={change.targetId}>
                {item.target?.name ?? `#${change.targetId}`}
              </option>
            )}
            {tags
              .filter(
                (tag) =>
                  tag.id !== change.tagId && tag.folder_id === before?.folder_id
              )
              .map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
          </select>
        </label>
      )}
      {requiresManualConfirmation(item) && (
        <Label className="rounded-md border border-border/60 bg-background/70 px-2.5 py-2 text-xs font-normal">
          <Checkbox
            checked={choice.confirmManual === true}
            onCheckedChange={(value) =>
              onChange({ confirmManual: value === true })
            }
          />
          {t("confirmManual")}
        </Label>
      )}
      {requiresDeleteConfirmation(item) && (
        <Label className="rounded-md border border-border/60 bg-background/70 px-2.5 py-2 text-xs font-normal">
          <Checkbox
            checked={choice.confirmDelete === true}
            onCheckedChange={(value) =>
              onChange({ confirmDelete: value === true })
            }
          />
          {t("confirmDelete")}
        </Label>
      )}
    </div>
  )
}

function Preview({
  job,
  busy,
  onApply,
}: {
  job: CurationJob
  busy: boolean
  onApply: (choices: CurationChoice[]) => void
}) {
  const t = useTranslations("TagCuration")
  const [selected, setSelected] = useState<Record<number, CurationChoice>>({})
  const choices = Object.values(selected)
  const ready =
    choices.length > 0 &&
    choices.every((choice) => {
      const item = job.items[choice.index]
      return (
        (choice.name == null || choice.name.trim().length > 0) &&
        (!requiresManualConfirmation(item) || choice.confirmManual) &&
        (!requiresDeleteConfirmation(item) || choice.confirmDelete) &&
        (item.change.kind !== "add" ||
          item.change.tagId > 0 ||
          choices.some((other) => {
            const referenced = job.items[other.index].change
            return (
              referenced.kind === "create" &&
              referenced.tagId === item.change.tagId
            )
          }))
      )
    })
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-muted/30 px-3 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ListChecks className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{t("open")}</p>
            <p className="text-xs text-muted-foreground">
              {t("batch", { count: job.items.length })}
            </p>
          </div>
        </div>
        <span className="rounded-full border border-border/70 bg-background/70 px-2.5 py-1 text-xs font-medium tabular-nums">
          {choices.length} / {job.items.length}
        </span>
      </div>
      {job.notices.length > 0 && (
        <details
          className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs"
          open
        >
          <summary>{t("limitTitle")}</summary>
          <ul className="mt-2 max-h-24 space-y-1 overflow-y-auto">
            {job.notices.map((notice) => (
              <li key={`${notice.id}/${notice.dimension}`}>
                {t("limitItem", {
                  name: notice.title || t("session", { id: notice.id }),
                  dimension: t(notice.dimension),
                  count: notice.count,
                })}
              </li>
            ))}
          </ul>
        </details>
      )}
      {job.items.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      )}
      <ul className="grid max-h-[45dvh] gap-2 overflow-y-auto rounded-xl border border-border/60 bg-muted/10 p-2 pr-1">
        {job.items.map((item, index) => {
          const choice = selected[index]
          return (
            <li
              key={index}
              className="grid gap-2 rounded-lg border border-border/70 bg-card/80 p-3 transition-colors hover:border-foreground/20"
            >
              <Label className="flex cursor-pointer items-start gap-3">
                <Checkbox
                  className="mt-0.5"
                  checked={Boolean(choice)}
                  disabled={busy}
                  onCheckedChange={(value) =>
                    setSelected((previous) => {
                      const next = { ...previous }
                      if (value === true) next[index] = { index }
                      else delete next[index]
                      return next
                    })
                  }
                />
                <span className="min-w-0 text-sm font-medium leading-5">
                  {t(item.change.kind, { name: itemName(item) })}
                </span>
              </Label>
              <ChangeSummary item={item} />
              {choice && (
                <ReviewFields
                  item={item}
                  choice={choice}
                  onChange={(patch) =>
                    setSelected((previous) => ({
                      ...previous,
                      [index]: { ...previous[index], ...patch },
                    }))
                  }
                />
              )}
            </li>
          )
        })}
      </ul>
      {job.items.length > 0 && (
        <div className="sticky bottom-0 -mx-1 flex items-center justify-between gap-3 border-t border-border/70 bg-background/95 px-1 pb-1 pt-3 backdrop-blur">
          <span className="text-xs text-muted-foreground">
            {t("batch", { count: choices.length })}
          </span>
          <Button disabled={busy || !ready} onClick={() => onApply(choices)}>
            {t("apply", { count: choices.length })}
          </Button>
        </div>
      )}
    </div>
  )
}

type Confirmation = { action: "discard" | "undo" | "purge"; id: string }

function CurationPanel() {
  const t = useTranslations("TagCuration")
  const format = useFormatter()
  const [job, setJob] = useState<CurationJob | null>()
  const [history, setHistory] = useState<CurationJob[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [reload, setReload] = useState(0)
  const running = job?.state === "queued" || job?.state === "running"

  useEffect(() => {
    let active = true
    Promise.all([
      requestTagCuration({ action: "status" }),
      requestTagCuration({ action: "history" }),
    ])
      .then(([pending, batches]) => {
        if (!active) return
        setJob(pending)
        setHistory(batches)
      })
      .catch(() => {
        if (active) setError(t("loadFailed"))
      })
    return () => {
      active = false
    }
  }, [reload, t])

  useEffect(() => {
    if (!running) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await requestTagCuration({ action: "status" })
        if (!active) return
        setJob(next)
        setError(null)
      } catch {
        if (active) setError(t("loadFailed"))
      } finally {
        if (active) timer = setTimeout(poll, 2000)
      }
    }
    timer = setTimeout(poll, 1000)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [running, t])

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (failure) {
      const response = extractAppCommandError(failure)
      setError(
        response?.code === "already_exists"
          ? t("conflict", { detail: response.message })
          : response?.code === "invalid_input"
            ? t("invalid", { detail: response.message })
            : t("operationFailed")
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-0 gap-4">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {job === undefined &&
        (error ? (
          <Button
            onClick={() => {
              setError(null)
              setReload(reload + 1)
            }}
          >
            {t("retry")}
          </Button>
        ) : (
          <Loader2 className="size-4 animate-spin" aria-label={t("loading")} />
        ))}
      {job === null && (
        <Button
          className="justify-self-start"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setJob(await requestTagCuration({ action: "start" }))
            })
          }
        >
          {t("start")}
        </Button>
      )}
      {job && (
        <section className="grid gap-3">
          {running && (
            <p role="status" className="flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" />
              {job.total > 0
                ? t("progress", { count: job.scanned, total: job.total })
                : t("queued")}
            </p>
          )}
          {job.state === "failed" && (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-sm text-destructive">
                {t(`failure.${job.error ?? "interrupted"}`)}
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setJob(
                      await requestTagCuration({ action: "retry", id: job.id })
                    )
                  })
                }
              >
                {t("retry")}
              </Button>
            </div>
          )}
          {job.state === "review" && (
            <Preview
              key={job.id}
              job={job}
              busy={busy}
              onApply={(choices) =>
                void run(async () => {
                  await requestTagCuration({
                    action: "apply",
                    id: job.id,
                    choices,
                  })
                  setJob(null)
                  setReload(reload + 1)
                  void useConversationTagsStore.getState().fetchTags()
                })
              }
            />
          )}
          <Button
            variant="ghost"
            size="sm"
            className="justify-self-start"
            disabled={busy}
            onClick={() => setConfirmation({ action: "discard", id: job.id })}
          >
            {t("discard")}
          </Button>
        </section>
      )}
      {history.length > 0 && (
        <section className="grid gap-2 border-t border-border/70 pt-4">
          <h3 className="text-sm font-medium">{t("history")}</h3>
          {history.length >= 20 && (
            <p role="status" className="text-xs text-muted-foreground">
              {t("historyLimit", { count: history.length })}
            </p>
          )}
          <ul className="grid max-h-[30dvh] gap-2 overflow-y-auto">
            {history.map((batch) => (
              <li
                key={batch.id}
                className="grid gap-2 rounded-xl border border-border/70 bg-muted/10 p-3"
              >
                <details className="text-sm">
                  <summary className="cursor-pointer">
                    {format.dateTime(new Date(batch.createdAt * 1000), {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}{" "}
                    · {t("batch", { count: batch.items.length })}
                    {batch.state === "undone" ? ` · ${t("undone")}` : ""}
                  </summary>
                  <ul className="mt-2 space-y-2 pl-3">
                    {batch.items.map((item, index) => (
                      <li key={index}>
                        {t(item.change.kind, { name: itemName(item) })}
                        <ChangeSummary item={item} />
                      </li>
                    ))}
                  </ul>
                </details>
                <div className="flex gap-2">
                  {batch.state === "applied" && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        setConfirmation({ action: "undo", id: batch.id })
                      }
                    >
                      {t("undo")}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      setConfirmation({ action: "purge", id: batch.id })
                    }
                  >
                    {t("purge")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <AlertDialog
        open={confirmation != null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null)
        }}
      >
        {confirmation && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t(confirmation.action)}</AlertDialogTitle>
              <AlertDialogDescription>
                {t(`${confirmation.action}Description`)}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>
                {t("cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={busy}
                onClick={(event) => {
                  event.preventDefault()
                  const confirmed = confirmation
                  void run(async () => {
                    setConfirmation(null)
                    await requestTagCuration(confirmed)
                    if (confirmed.action === "discard") setJob(null)
                    if (confirmed.action === "undo")
                      void useConversationTagsStore.getState().fetchTags()
                    setReload(reload + 1)
                  })
                }}
              >
                {t("confirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </div>
  )
}

export function ConversationTagCuration() {
  const t = useTranslations("TagCuration")
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="justify-self-start">
          <Sparkles className="size-3.5" />
          {t("open")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/70 px-6 pb-4 pt-6">
          <DialogTitle className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Sparkles className="size-4" />
            </span>
            {t("open")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {open && (
          <div className="min-h-0 overflow-y-auto px-6 py-5">
            <CurationPanel />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Bookmark, Loader2, RefreshCw, Search, Trash2 } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"

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
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { listPromptStash, removePromptStash } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { PromptStashEntry } from "@/lib/types"

const FILTERS = ["all", "completed", "unused", "legacy", "draft"] as const
type StashFilter = (typeof FILTERS)[number]
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000

export function PromptStashSettings() {
  const t = useTranslations("PromptStashSettings")
  const locale = useLocale()
  const [entries, setEntries] = useState<PromptStashEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<StashFilter>("all")
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [pendingIds, setPendingIds] = useState<number[] | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [unusedBefore] = useState(() => Date.now() - THIRTY_DAYS)
  const mounted = useRef(false)
  const lifetime = useRef(0)
  const requestVersion = useRef(0)
  const deleteLock = useRef(false)

  const loadEntries = useCallback(async () => {
    const version = ++requestVersion.current
    const owner = lifetime.current
    const isCurrent = () =>
      mounted.current &&
      owner === lifetime.current &&
      version === requestVersion.current

    setLoading(true)
    setLoadError(null)
    try {
      // 管理列表不传 scope；只读取元数据，不调用恢复接口生成附件。
      const result = await listPromptStash()
      if (!isCurrent()) return
      setEntries(result)
      const existingIds = new Set(result.map((entry) => entry.id))
      setSelected(
        (previous) => new Set([...previous].filter((id) => existingIds.has(id)))
      )
    } catch (error) {
      if (isCurrent()) setLoadError(toErrorMessage(error))
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    lifetime.current += 1
    void loadEntries()
    return () => {
      // 同时隔离卸载和 StrictMode 重挂载，旧请求不能写回新页面。
      mounted.current = false
      lifetime.current += 1
      requestVersion.current += 1
    }
  }, [loadEntries])

  const visibleEntries = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    return entries.filter((entry) => {
      const matchesSearch = [
        entry.preview,
        entry.conversationTitle,
        entry.folderName,
      ].some((value) => value?.toLocaleLowerCase().includes(search))
      if (search && !matchesSearch) return false
      switch (filter) {
        case "completed":
          return (
            entry.conversationStatus === "completed" ||
            entry.conversationStatus === "cancelled"
          )
        case "unused":
          return Date.parse(entry.updatedAt) < unusedBefore
        case "legacy":
          return entry.scopeKey === null
        case "draft":
          // 归属只信任服务端 scope，不能根据标题、项目或 ID 猜测旧数据。
          return entry.scopeKey !== null && !entry.scopeKey.startsWith("conv:")
        default:
          return true
      }
    })
  }, [entries, filter, query, unusedBefore])

  const selectedVisibleCount = visibleEntries.filter((entry) =>
    selected.has(entry.id)
  ).length
  const allVisibleSelected =
    visibleEntries.length > 0 && selectedVisibleCount === visibleEntries.length
  const busy = loading || deleting
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [locale]
  )

  function toggleVisible(checked: boolean) {
    setSelected((previous) => {
      const next = new Set(previous)
      for (const entry of visibleEntries) {
        if (checked) next.add(entry.id)
        else next.delete(entry.id)
      }
      return next
    })
  }

  async function confirmDelete() {
    if (!pendingIds?.length || deleteLock.current) return
    // 确认目标是 ID 快照，后续筛选、勾选或刷新都不能扩大删除范围。
    const ids = [...pendingIds]
    const owner = lifetime.current
    const isCurrent = () => mounted.current && owner === lifetime.current
    deleteLock.current = true
    requestVersion.current += 1
    setDeleting(true)
    setDeleteError(null)
    try {
      const results = await Promise.allSettled(
        ids.map(async (id) => removePromptStash(id))
      )
      if (!isCurrent()) return
      const succeeded = new Set<number>()
      const failures: string[] = []
      results.forEach((result, index) => {
        if (result.status === "fulfilled") succeeded.add(ids[index])
        else failures.push(toErrorMessage(result.reason))
      })
      setEntries((previous) =>
        previous.filter((entry) => !succeeded.has(entry.id))
      )
      setSelected(
        (previous) => new Set([...previous].filter((id) => !succeeded.has(id)))
      )
      setPendingIds(null)
      if (failures.length > 0) {
        // 部分失败保留原行及其选择，不用一次全量替换掩盖失败项。
        setDeleteError(
          t("deleteFailed", {
            count: failures.length,
            message: [...new Set(failures)].join("; "),
          })
        )
      } else {
        // 刷新结果是新的事实；刷新后不再套用旧快照过滤，避免误删新收藏。
        await loadEntries()
      }
    } finally {
      deleteLock.current = false
      if (isCurrent()) setDeleting(false)
    }
  }

  function sourceLabel(entry: PromptStashEntry) {
    if (entry.scopeKey === null) return t("legacySource")
    if (!entry.scopeKey.startsWith("conv:")) return t("draftSource")
    return entry.conversationTitle || t("untitledConversation")
  }

  return (
    <section className="mx-auto w-full max-w-6xl space-y-4 p-5 sm:p-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Bookmark className="size-4" strokeWidth={1.5} aria-hidden />
          {t("title")}
        </h1>
        <p className="text-muted-foreground text-[13px]">{t("description")}</p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-2 left-2.5 size-4"
            strokeWidth={1.5}
            aria-hidden
          />
          <Input
            aria-label={t("search")}
            placeholder={t("search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-8 rounded-md pl-8 text-[13px]"
          />
        </div>
        <Select
          value={filter}
          onValueChange={(value) => setFilter(value as StashFilter)}
        >
          <SelectTrigger
            aria-label={t("filter")}
            className="h-8 w-44 rounded-md text-[13px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTERS.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`filters.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 rounded-md"
          disabled={busy}
          onClick={() => void loadEntries()}
        >
          <RefreshCw className="size-4" strokeWidth={1.5} aria-hidden />
          {t("refresh")}
        </Button>
      </div>

      {filter === "unused" && (
        <p className="text-muted-foreground text-[11px]">{t("unusedHint")}</p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
        <p className="text-muted-foreground tabular-nums" aria-live="polite">
          {t("results", {
            visible: visibleEntries.length,
            total: entries.length,
          })}
          {selected.size > 0 && ` · ${t("selected", { count: selected.size })}`}
        </p>
        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 rounded-md"
              disabled={deleting}
              onClick={() => setSelected(new Set())}
            >
              {t("clearSelection")}
            </Button>
          )}
          <Button
            variant="destructive"
            size="sm"
            className="h-8 rounded-md"
            disabled={busy || selected.size === 0}
            onClick={() => setPendingIds([...selected])}
          >
            <Trash2 className="size-4" strokeWidth={1.5} aria-hidden />
            {t("deleteSelected")}
          </Button>
        </div>
      </div>

      {loadError !== null && (
        <div
          role="alert"
          className="text-destructive flex items-center gap-2 text-[13px]"
        >
          <span>{t("loadFailed", { message: loadError })}</span>
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-md"
            disabled={busy}
            onClick={() => void loadEntries()}
          >
            {t("retry")}
          </Button>
        </div>
      )}
      {deleteError !== null && (
        <p role="alert" className="text-destructive text-[13px]">
          {deleteError}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border" aria-busy={busy}>
        <table className="w-full min-w-190 text-left text-[13px]">
          <caption className="sr-only">{t("title")}</caption>
          <thead className="bg-muted/40 text-muted-foreground border-b text-[11px]">
            <tr className="h-10">
              <th className="w-10 px-3" scope="col">
                <Checkbox
                  aria-label={t("selectFiltered")}
                  disabled={busy || visibleEntries.length === 0}
                  checked={
                    allVisibleSelected
                      ? true
                      : selectedVisibleCount > 0
                        ? "indeterminate"
                        : false
                  }
                  onCheckedChange={(checked) => toggleVisible(checked === true)}
                />
              </th>
              <th className="px-3 font-medium" scope="col">
                {t("columns.preview")}
              </th>
              <th className="px-3 font-medium" scope="col">
                {t("columns.source")}
              </th>
              <th className="px-3 font-medium" scope="col">
                {t("columns.status")}
              </th>
              <th className="px-3 font-medium" scope="col">
                {t("columns.savedAt")}
              </th>
              <th className="px-3 text-right font-medium" scope="col">
                {t("columns.attachments")}
              </th>
              <th className="px-3 font-medium" scope="col">
                <span className="sr-only">{t("columns.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {visibleEntries.map((entry) => {
              const preview = entry.preview || t("attachmentOnly")
              const date = new Date(entry.updatedAt)
              return (
                <tr key={entry.id} className="hover:bg-muted/30 h-10">
                  <td className="px-3 py-2">
                    <Checkbox
                      aria-label={t("selectEntry", { preview })}
                      checked={selected.has(entry.id)}
                      disabled={busy}
                      onCheckedChange={(checked) => {
                        setSelected((previous) => {
                          const next = new Set(previous)
                          if (checked === true) next.add(entry.id)
                          else next.delete(entry.id)
                          return next
                        })
                      }}
                    />
                  </td>
                  <td className="w-2/5 px-3 py-2">
                    <p
                      className="line-clamp-2 max-w-md wrap-anywhere whitespace-pre-wrap"
                      title={preview}
                    >
                      {preview}
                    </p>
                  </td>
                  <td className="max-w-48 px-3 py-2">
                    <p className="truncate" title={sourceLabel(entry)}>
                      {sourceLabel(entry)}
                    </p>
                    <p
                      className="text-muted-foreground truncate text-[11px]"
                      title={entry.folderName ?? undefined}
                    >
                      {entry.folderName || t("noProject")}
                    </p>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {entry.conversationDeleted
                      ? t("statuses.deleted")
                      : entry.conversationStatus
                        ? t(`statuses.${entry.conversationStatus}`)
                        : t("statuses.none")}
                  </td>
                  <td className="text-muted-foreground px-3 py-2 tabular-nums whitespace-nowrap">
                    {Number.isNaN(date.getTime()) ? (
                      t("unknownTime")
                    ) : (
                      <time dateTime={entry.updatedAt}>
                        {dateFormatter.format(date)}
                      </time>
                    )}
                  </td>
                  <td
                    className="px-3 py-2 text-right tabular-nums"
                    title={t("assetBytes", { bytes: entry.assetBytes })}
                  >
                    {entry.attachmentCount}
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive size-8 rounded-md"
                      aria-label={t("deleteEntry", { preview })}
                      disabled={busy}
                      onClick={() => setPendingIds([entry.id])}
                    >
                      <Trash2
                        className="size-4"
                        strokeWidth={1.5}
                        aria-hidden
                      />
                    </Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {loading && (
          <p
            role="status"
            className="text-muted-foreground flex items-center justify-center gap-2 p-5 text-[13px]"
          >
            <Loader2
              className="size-4 animate-spin"
              strokeWidth={1.5}
              aria-hidden
            />
            {t("loading")}
          </p>
        )}
        {!loading && loadError === null && visibleEntries.length === 0 && (
          <div className="text-muted-foreground space-y-2 p-5 text-center text-[13px]">
            <p>{entries.length === 0 ? t("empty") : t("noResults")}</p>
            {entries.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 rounded-md"
                onClick={() => {
                  setQuery("")
                  setFilter("all")
                }}
              >
                {t("clearFilters")}
              </Button>
            )}
          </div>
        )}
      </div>

      <AlertDialog
        open={pendingIds !== null}
        onOpenChange={(open) => {
          if (!open && !deleteLock.current) setPendingIds(null)
        }}
      >
        <AlertDialogContent className="rounded-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("confirmDelete.title", { count: pendingIds?.length ?? 0 })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("confirmDelete.description", {
                count: pendingIds?.length ?? 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting} className="rounded-md">
              {t("confirmDelete.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              className="rounded-md"
              onClick={(event) => {
                event.preventDefault()
                void confirmDelete()
              }}
            >
              {deleting ? t("deleting") : t("confirmDelete.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

"use client"

import { useEffect, useId, useRef, useState } from "react"
import { ArchiveRestore, Loader2, RefreshCw, X } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { toErrorMessage } from "@/lib/app-error"
import {
  fileCheckpoint,
  type FileCheckpointOperation,
  type FileCheckpointPlan,
  type FileCheckpointResponse,
} from "@/lib/file-checkpoint"

export interface FileCheckpointPanelProps {
  conversationId: number | null
  isViewer: boolean
  busy: boolean
}

export function FileCheckpointPanel(props: FileCheckpointPanelProps) {
  if (
    props.isViewer ||
    props.conversationId === null ||
    !Number.isSafeInteger(props.conversationId) ||
    props.conversationId <= 0
  )
    return null

  return (
    <FileCheckpointPanelContent
      key={props.conversationId}
      conversationId={props.conversationId}
      busy={props.busy}
    />
  )
}

function FileCheckpointPanelContent({
  conversationId,
  busy,
}: {
  conversationId: number
  busy: boolean
}) {
  const t = useTranslations("FileCheckpoint")
  const selectionId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const mounted = useRef(false)
  const request = useRef<object | null>(null)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [data, setData] = useState<FileCheckpointResponse | null>(null)
  const [plan, setPlan] = useState<FileCheckpointPlan | null>(null)
  const [paths, setPaths] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<
    { kind: "apply" } | { kind: "delete"; checkpointId: string } | null
  >(null)
  const locked = busy || pending

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      request.current = null
    }
  }, [])

  useEffect(() => {
    if (!pending) return
    // 与分叉进度相同：捕获阶段锁住全局快捷键、切换和拖放，避免写入中切走。
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
  }, [pending])

  const run = async (operation: FileCheckpointOperation) => {
    if (busy || request.current) return
    const token = {}
    request.current = token
    setPending(true)
    setError(null)
    setNotice(null)
    setConfirmation(null)
    // 计划只对应预览时的磁盘状态；刷新、失败和其他操作均不能沿用旧计划。
    setPlan(null)
    setPaths([])
    try {
      const result = await fileCheckpoint({ conversationId, ...operation })
      if (!mounted.current || request.current !== token) return
      setData(result)
      if (operation.action === "preview" || operation.action === "undo") {
        if (!result.plan) throw new Error(t("missingPlan"))
        setPlan(result.plan)
        setPaths(result.plan.entries.map((entry) => entry.path))
      } else if (operation.action !== "list") {
        setNotice(t("completed"))
      }
    } catch (failure: unknown) {
      if (!mounted.current || request.current !== token) return
      setData(null)
      setPlan(null)
      setPaths([])
      setError(toErrorMessage(failure))
    } finally {
      if (mounted.current && request.current === token) {
        request.current = null
        setPending(false)
      }
    }
  }

  const changeOpen = (next: boolean) => {
    if (request.current) return
    setOpen(next)
    if (next) void run({ action: "list" })
    else {
      setPlan(null)
      setPaths([])
      setConfirmation(null)
    }
  }

  const selected =
    plan?.entries.filter((entry) => paths.includes(entry.path)) ?? []
  const counts = {
    added: selected.filter((entry) => entry.change === "added").length,
    modified: selected.filter((entry) => entry.change === "modified").length,
    deleted: selected.filter((entry) => entry.change === "deleted").length,
  }

  return (
    <>
      <Button
        ref={trigger}
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 min-w-0 gap-1.5 rounded-md px-2 text-[13px] text-muted-foreground"
        disabled={locked}
        title={busy ? t("waitForCompletion") : t("title")}
        onClick={() => changeOpen(true)}
      >
        <ArchiveRestore
          className="size-4"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        <span className="truncate">{t("title")}</span>
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent
          showCloseButton={false}
          className="max-w-3xl gap-3 rounded-lg p-4 text-[13px]"
          aria-busy={pending}
          onEscapeKeyDown={(event) => {
            if (request.current) event.preventDefault()
          }}
          onInteractOutside={(event) => {
            if (request.current) event.preventDefault()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            trigger.current?.focus()
          }}
        >
          <DialogHeader className="pr-8">
            <DialogTitle className="text-[15px]">{t("title")}</DialogTitle>
            <DialogDescription className="text-[13px]">
              {t("description")}
            </DialogDescription>
          </DialogHeader>
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="absolute top-3 right-3 rounded-md"
              disabled={pending}
              aria-label={t("close")}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </DialogClose>
          <div className="space-y-1 text-[11px] text-muted-foreground">
            <p>{t("fromNow")}</p>
            <p>{t("excluded")}</p>
            <p>{t("sharedDirectory")}</p>
            <p>{t("limits")}</p>
          </div>
          {data && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-y border-border py-2">
              <span className="font-medium">
                {t(data.enabled ? "enabled" : "disabled")}
              </span>
              <span
                className="min-w-0 break-all font-mono text-[11px]"
                title={data.root}
              >
                {data.root}
              </span>
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-md"
              disabled={locked || !data}
              onClick={() =>
                void run({ action: data?.enabled ? "disable" : "enable" })
              }
            >
              {t(data?.enabled ? "disable" : "enable")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-md"
              disabled={locked || !data}
              onClick={() => void run({ action: "capture" })}
            >
              {t("capture")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="rounded-md"
              disabled={locked || !data?.lastRestoreId}
              onClick={() => {
                if (data?.lastRestoreId)
                  void run({ action: "undo", planId: data.lastRestoreId })
              }}
            >
              {t("undo")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto rounded-md"
              disabled={locked}
              onClick={() => void run({ action: "list" })}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              {t("refresh")}
            </Button>
          </div>
          {busy && <p role="status">{t("waitForCompletion")}</p>}
          {pending && (
            <div
              role="status"
              className="flex items-center gap-2 text-muted-foreground"
            >
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              {t("working")}
            </div>
          )}
          {error && (
            <div role="alert" className="space-y-1 text-destructive">
              <p>{error}</p>
              <p>{t("errorHelp")}</p>
            </div>
          )}
          {notice && (
            <p role="status" className="text-muted-foreground">
              {notice}
            </p>
          )}
          {data && data.checkpoints.length === 0 && <p>{t("empty")}</p>}
          {data && data.checkpoints.length > 0 && (
            <ul
              aria-label={t("snapshots")}
              className="max-h-44 overflow-y-auto divide-y divide-border"
            >
              {data.checkpoints.map((checkpoint) => (
                <li
                  key={checkpoint.id}
                  className="flex items-center gap-2 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p
                      className="truncate font-medium"
                      title={checkpoint.label}
                    >
                      {checkpoint.label}
                    </p>
                    <p className="break-words text-[11px] text-muted-foreground">
                      <time dateTime={checkpoint.createdAt}>
                        {checkpoint.createdAt}
                      </time>
                      {" · "}
                      {t("metadata", {
                        conversationId: checkpoint.conversationId,
                        count: checkpoint.fileCount,
                        bytes: checkpoint.bytes,
                      })}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="rounded-md"
                    disabled={locked}
                    onClick={() =>
                      void run({
                        action: "preview",
                        checkpointId: checkpoint.id,
                      })
                    }
                  >
                    {t("preview")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="rounded-md text-destructive"
                    disabled={locked}
                    onClick={() => {
                      setPlan(null)
                      setPaths([])
                      setConfirmation({
                        kind: "delete",
                        checkpointId: checkpoint.id,
                      })
                    }}
                  >
                    {t("delete")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {plan && (
            <section
              aria-label={t("previewTitle")}
              className="space-y-2 border-t border-border pt-3"
            >
              <h3 className="font-medium">{t("previewTitle")}</h3>
              <p className="text-[11px] text-muted-foreground">
                {t("previewHelp")}
              </p>
              {plan.entries.length === 0 ? (
                <p>{t("noChanges")}</p>
              ) : (
                <>
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={
                        paths.length === plan.entries.length
                          ? true
                          : paths.length === 0
                            ? false
                            : "indeterminate"
                      }
                      disabled={locked}
                      onCheckedChange={(checked) => {
                        setPaths(
                          checked === true
                            ? plan.entries.map((entry) => entry.path)
                            : []
                        )
                        setConfirmation(null)
                      }}
                    />
                    {t("selectAll")}
                  </label>
                  <ul className="max-h-72 space-y-2 overflow-y-auto">
                    {plan.entries.map((entry, index) => (
                      <li
                        key={entry.path}
                        className="space-y-2 rounded-md border border-border p-2"
                      >
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id={`${selectionId}-${index}`}
                            checked={paths.includes(entry.path)}
                            disabled={locked}
                            onCheckedChange={(checked) => {
                              setPaths((current) =>
                                checked === true
                                  ? [...current, entry.path]
                                  : current.filter(
                                      (path) => path !== entry.path
                                    )
                              )
                              setConfirmation(null)
                            }}
                          />
                          <label
                            htmlFor={`${selectionId}-${index}`}
                            className="min-w-0 flex-1 break-all font-mono text-[11px]"
                          >
                            {entry.path}
                          </label>
                          <span className="text-[11px] text-muted-foreground">
                            {t(entry.change)}
                          </span>
                        </div>
                        {entry.binary ? (
                          <p className="text-[11px] text-muted-foreground">
                            {t("binary")}
                          </p>
                        ) : (
                          <details open>
                            <summary className="cursor-pointer text-[11px] text-muted-foreground">
                              {t("diff")}
                            </summary>
                            <div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2">
                              <div className="min-w-0">
                                <p className="text-[11px] text-muted-foreground">
                                  {t("current")}
                                </p>
                                <pre className="max-h-40 overflow-auto rounded bg-destructive/5 p-2 text-[11px]">
                                  <code>
                                    {entry.beforeText === null
                                      ? t("absent")
                                      : entry.beforeText}
                                  </code>
                                </pre>
                              </div>
                              <div className="min-w-0">
                                <p className="text-[11px] text-muted-foreground">
                                  {t("target")}
                                </p>
                                <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-[11px]">
                                  <code>
                                    {entry.afterText === null
                                      ? t("absent")
                                      : entry.afterText}
                                  </code>
                                </pre>
                              </div>
                            </div>
                          </details>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <p className="text-[11px] tabular-nums">{t("counts", counts)}</p>
            </section>
          )}
          {confirmation && (
            <div
              role="alert"
              className="space-y-1 rounded-md border border-destructive/30 p-3"
            >
              <p className="font-medium">
                {t(
                  confirmation.kind === "apply"
                    ? "confirmRestore"
                    : "confirmDelete"
                )}
              </p>
              <p>
                {confirmation.kind === "apply"
                  ? t("confirmation", counts)
                  : t("deleteHelp")}
              </p>
            </div>
          )}
          {(plan || confirmation) && (
            <DialogFooter className="border-t border-border pt-3">
              {confirmation ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="rounded-md"
                    disabled={locked}
                    onClick={() => setConfirmation(null)}
                  >
                    {t("cancel")}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    className="rounded-md"
                    disabled={
                      locked ||
                      (confirmation.kind === "apply" &&
                        (!plan || paths.length === 0))
                    }
                    onClick={() => {
                      if (confirmation.kind === "delete")
                        void run({
                          action: "delete",
                          checkpointId: confirmation.checkpointId,
                        })
                      else if (plan && paths.length > 0)
                        void run({ action: "apply", planId: plan.id, paths })
                    }}
                  >
                    {t(
                      confirmation.kind === "apply" ? "apply" : "deleteSnapshot"
                    )}
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  className="rounded-md"
                  disabled={locked || paths.length === 0}
                  onClick={() => setConfirmation({ kind: "apply" })}
                >
                  {t("reviewRestore")}
                </Button>
              )}
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

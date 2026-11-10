"use client"

import { useCallback, useEffect, useId, useRef, useState } from "react"
import {
  ArrowLeft,
  ChevronDown,
  Columns2,
  GitBranch,
  RefreshCw,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Textarea } from "@/components/ui/textarea"
import { PromptForkPicker } from "./prompt-fork-picker"
import { ConversationForkProgress } from "./conversation-fork-progress"
import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import {
  cancelResearchBranchSummary,
  createResearchBranch,
  generateResearchBranchSummary,
  listResearchBranches,
  RESEARCH_BRANCH_MAX_SUMMARY_CHARS,
  saveResearchBranchSummary,
  type ResearchBranchInfo,
  type ForkPromptSnapshot,
} from "@/lib/research-branch"
import { getTransport } from "@/lib/transport"
import {
  finishResearchCreation,
  pendingResearchCreation,
  rememberResearchCreation,
} from "@/lib/research-branch-pending"
import {
  readResearchSummaryDraft,
  writeResearchSummaryDraft,
} from "@/lib/research-summary-handoff"

export interface ResearchBranchPanelProps {
  conversationId: number | null
  connectionId: string | null
  supportsFork: boolean
  connectionReady: boolean
  isViewer: boolean
  busy: boolean
  onOpenConversation: (
    conversationId: number,
    split?: boolean
  ) => void | Promise<void>
  onReturnSummary: (sourceConversationId: number, summary: string) => void
  onCreated?: (info: ResearchBranchInfo) => void
  onForkFromPrompt?: (
    turnId: string,
    text: string,
    fromStart?: boolean,
    sourcePrompt?: ForkPromptSnapshot
  ) => Promise<boolean>
}

interface OperationError {
  action: "create" | "generate" | "save" | "return" | "cancel"
  message: string
  requestId?: string
}

export function ResearchBranchPanel(props: ResearchBranchPanelProps) {
  if (props.conversationId === null || props.conversationId <= 0) return null

  // 切换会话或连接时隔离整个异步作用域，旧保存结果不能回填新来源。
  return (
    <ResearchBranchPanelContent
      key={`${props.conversationId}:${props.connectionId ?? ""}`}
      {...props}
      conversationId={props.conversationId}
    />
  )
}

function ResearchBranchPanelContent({
  conversationId,
  connectionId,
  supportsFork,
  connectionReady,
  isViewer,
  busy,
  onOpenConversation,
  onReturnSummary,
  onCreated,
  onForkFromPrompt,
}: ResearchBranchPanelProps & { conversationId: number }) {
  const t = useTranslations("ResearchBranch")
  const summaryId = useId()
  const unavailableId = useId()
  const [menuOpen, setMenuOpen] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [relations, setRelations] = useState<ResearchBranchInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<OperationError | null>(
    null
  )
  const [creating, setCreating] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<
    "saved" | "generated" | "returned" | null
  >(null)
  const [draft, setDraft] = useState(
    () => readResearchSummaryDraft(conversationId) ?? { text: "", saved: "" }
  )
  const draftRef = useRef(draft)
  const mounted = useRef(false)
  const loadVersion = useRef(0)
  const createRequest = useRef<string | null>(null)
  const generateRequest = useRef<string | null>(null)
  const saveRequest = useRef<object | null>(null)
  const summaryTrigger = useRef<HTMLButtonElement>(null)

  const updateDraft = useCallback(
    (next: typeof draft) => {
      draftRef.current = next
      setDraft(next)
      // 视图切换会卸载面板，未保存编辑仍按真实会话保留，重连后也不能丢稿。
      writeResearchSummaryDraft(conversationId, next)
    },
    [conversationId]
  )

  const reload = useCallback(async () => {
    const version = ++loadVersion.current
    setLoading(true)
    setLoadError(null)
    try {
      const loaded = await listResearchBranches(conversationId)
      if (!mounted.current || version !== loadVersion.current) return
      setRelations(loaded)
      const ownBranch = loaded.find(
        (info) => info.branchConversationId === conversationId
      )
      // 重连和手动刷新只更新干净草稿，不能覆盖用户未保存的编辑。
      if (
        ownBranch &&
        draftRef.current.text === draftRef.current.saved &&
        generateRequest.current === null &&
        saveRequest.current === null
      ) {
        updateDraft({ text: ownBranch.summary, saved: ownBranch.summary })
      }
    } catch (error: unknown) {
      if (mounted.current && version === loadVersion.current) {
        setLoadError(toErrorMessage(error))
      }
    } finally {
      if (mounted.current && version === loadVersion.current) setLoading(false)
    }
  }, [conversationId, updateDraft])

  useEffect(() => {
    mounted.current = true
    void reload()
    // 不订阅 token 流；关系仅随会话身份、传输重连或显式刷新加载。
    const unsubscribe = getTransport().onReconnect?.(() => void reload())
    return () => {
      mounted.current = false
      loadVersion.current += 1
      createRequest.current = null
      saveRequest.current = null
      const requestId = generateRequest.current
      generateRequest.current = null
      if (requestId) void cancelResearchBranchSummary(requestId).catch(() => {})
      unsubscribe?.()
    }
  }, [reload])

  const ownBranch = relations.find(
    (info) => info.branchConversationId === conversationId
  )
  const branches = relations.filter(
    (info) => info.sourceConversationId === conversationId
  )
  const summaryLength = Array.from(draft.text).length
  const tooLong = summaryLength > RESEARCH_BRANCH_MAX_SUMMARY_CHARS
  const dirty = draft.text !== draft.saved
  const working = creating || generating || saving
  const createDisabled =
    busy ||
    !supportsFork ||
    !connectionReady ||
    isViewer ||
    !connectionId ||
    working ||
    loading ||
    loadError !== null

  const create = async (retryRequestId?: string) => {
    if (
      createDisabled ||
      createRequest.current ||
      generateRequest.current ||
      saveRequest.current ||
      !connectionId
    )
      return
    const requestId =
      retryRequestId ??
      pendingResearchCreation(conversationId) ??
      crypto.randomUUID()
    rememberResearchCreation(conversationId, requestId)
    createRequest.current = requestId
    setMenuOpen(false)
    setCreating(true)
    setOperationError(null)
    setNotice(null)
    try {
      const info = await createResearchBranch({
        connectionId,
        sourceConversationId: conversationId,
        requestId,
      })
      finishResearchCreation(conversationId, requestId)
      if (!mounted.current || createRequest.current !== requestId) return
      loadVersion.current += 1
      setRelations((current) => [
        ...current.filter((item) => item.id !== info.id),
        info,
      ])
      setLoading(false)
      onCreated?.(info)
      await onOpenConversation(info.branchConversationId, true)
    } catch (error: unknown) {
      const code = extractAppCommandError(error)?.code
      if (
        code === "turn_in_progress" ||
        code === "invalid_input" ||
        code === "not_found"
      ) {
        finishResearchCreation(conversationId, requestId)
      }
      if (mounted.current && createRequest.current === requestId) {
        setOperationError({
          action: "create",
          message: toErrorMessage(error),
          requestId,
        })
      }
    } finally {
      if (mounted.current && createRequest.current === requestId) {
        createRequest.current = null
        setCreating(false)
      }
    }
  }

  const generate = async () => {
    if (
      !ownBranch ||
      busy ||
      working ||
      createRequest.current ||
      generateRequest.current ||
      saveRequest.current
    )
      return
    const requestId = crypto.randomUUID()
    generateRequest.current = requestId
    setGenerating(true)
    setOperationError(null)
    setNotice(null)
    try {
      const result = await generateResearchBranchSummary({
        branchConversationId: ownBranch.branchConversationId,
        requestId,
      })
      if (!mounted.current || generateRequest.current !== requestId) return
      if (
        Array.from(result.summary).length > RESEARCH_BRANCH_MAX_SUMMARY_CHARS
      ) {
        throw new Error(t("tooLong"))
      }
      updateDraft({ ...draftRef.current, text: result.summary })
      setNotice("generated")
    } catch (error: unknown) {
      if (mounted.current && generateRequest.current === requestId) {
        setOperationError({
          action: "generate",
          message: toErrorMessage(error),
        })
      }
    } finally {
      if (mounted.current && generateRequest.current === requestId) {
        generateRequest.current = null
        setGenerating(false)
      }
    }
  }

  const cancel = async (requestId = generateRequest.current) => {
    if (!requestId) return
    // 先失效再发取消：后端取消失败或响应晚到，也不能覆盖后续手动输入。
    if (generateRequest.current === requestId) {
      generateRequest.current = null
      setGenerating(false)
    }
    setOperationError(null)
    try {
      await cancelResearchBranchSummary(requestId)
    } catch (error: unknown) {
      if (mounted.current) {
        setOperationError({
          action: "cancel",
          message: toErrorMessage(error),
          requestId,
        })
      }
    }
  }

  const save = async (handoff: boolean) => {
    if (
      !ownBranch ||
      working ||
      createRequest.current ||
      generateRequest.current ||
      saveRequest.current
    )
      return
    const summary = draftRef.current.text
    if (
      Array.from(summary).length > RESEARCH_BRANCH_MAX_SUMMARY_CHARS ||
      (handoff && !summary.trim())
    )
      return
    const operation = {}
    saveRequest.current = operation
    setSaving(true)
    setOperationError(null)
    setNotice(null)
    try {
      const saved = await saveResearchBranchSummary(
        ownBranch.branchConversationId,
        summary
      )
      if (!mounted.current || saveRequest.current !== operation) return
      loadVersion.current += 1
      setLoading(false)
      setRelations((current) =>
        current.map((info) => (info.id === saved.id ? saved : info))
      )
      updateDraft({ text: saved.summary, saved: saved.summary })
      setNotice(handoff ? "returned" : "saved")
      // 只把已持久化摘要交给主线输入框；不发送正文，也不改变主线会话。
      if (handoff) {
        setSummaryOpen(false)
        onReturnSummary(ownBranch.sourceConversationId, saved.summary)
      }
    } catch (error: unknown) {
      if (mounted.current && saveRequest.current === operation) {
        setOperationError({
          action: handoff ? "return" : "save",
          message: toErrorMessage(error),
        })
      }
    } finally {
      if (mounted.current && saveRequest.current === operation) {
        saveRequest.current = null
        setSaving(false)
      }
    }
  }

  const retry = () => {
    switch (operationError?.action) {
      case "create":
        // 请求可能已完成原生 fork，沿用幂等 ID 取回结果，不能重试制造第二个旁支。
        void create(operationError.requestId)
        break
      case "generate":
        void generate()
        break
      case "save":
        void save(false)
        break
      case "return":
        void save(true)
        break
      case "cancel":
        void cancel(operationError.requestId)
        break
    }
  }

  // 未连接、握手未完成和只读视图都不代表代理不支持 fork。
  const unavailable = isViewer
    ? t("viewer")
    : !connectionId
      ? t("connectionRequired")
      : busy
        ? t("waitForCompletion")
        : !connectionReady
          ? t("connectionPending")
          : !supportsFork
            ? t("unsupported")
            : null

  const createButton = (
    <span
      className="min-w-0"
      title={
        onForkFromPrompt
          ? t("choosePrompt")
          : (unavailable ?? `${t("boundary")} ${t("sharedDirectory")}`)
      }
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 max-w-full min-w-0 gap-2 rounded-md px-2 text-[13px]"
        disabled={
          onForkFromPrompt
            ? working || loading || loadError !== null
            : createDisabled
        }
        aria-describedby={unavailable ? unavailableId : undefined}
        onClick={() => (onForkFromPrompt ? setPickerOpen(true) : void create())}
      >
        <GitBranch className="size-4" strokeWidth={1.5} aria-hidden="true" />
        <span className="truncate">
          {t(
            creating
              ? "creating"
              : onForkFromPrompt
                ? "forkConversation"
                : "create"
          )}
        </span>
      </Button>
    </span>
  )

  const operationFeedback = (
    <>
      {operationError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 text-[13px] text-destructive"
        >
          <span className="min-w-0 break-words">{operationError.message}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 rounded-md"
            disabled={
              working ||
              (operationError.action === "generate" && busy) ||
              (operationError.action === "create" && createDisabled) ||
              ((operationError.action === "save" ||
                operationError.action === "return") &&
                tooLong) ||
              (operationError.action === "return" && !draft.text.trim())
            }
            onClick={retry}
          >
            {t("retry")}
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="text-[11px] text-muted-foreground">
          {t(notice)}
        </p>
      )}
    </>
  )

  return (
    <section
      className="shrink-0 border-b border-border text-[13px]"
      aria-label={t("title")}
      aria-busy={loading}
    >
      <ConversationForkProgress open={creating} />
      {unavailable && (
        <span id={unavailableId} className="sr-only">
          {unavailable}
        </span>
      )}
      <div className="flex h-9 items-center gap-1 px-3">
        {ownBranch ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 min-w-0 shrink gap-2 rounded-md px-2 text-[13px]"
              onClick={() => onOpenConversation(ownBranch.sourceConversationId)}
            >
              <ArrowLeft
                className="size-4"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              <span className="truncate">{t("returnToSource")}</span>
            </Button>
            <span
              className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
              title={ownBranch.sourceTitle}
            >
              {ownBranch.sourceTitle}
            </span>
            <Button
              ref={summaryTrigger}
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 min-w-0 shrink rounded-md px-2 text-[13px]"
              onClick={() => setSummaryOpen(true)}
            >
              <span className="truncate">{t("bringBack")}</span>
            </Button>
          </>
        ) : (
          <>
            {createButton}
            <span className="flex-1" />
          </>
        )}
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 rounded-md px-2 text-[13px] text-muted-foreground"
              aria-label={t("branches")}
            >
              {ownBranch ? (
                <GitBranch
                  className="size-4"
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
              ) : (
                t("existing")
              )}
              {branches.length > 0 && (
                <span aria-hidden="true" className="text-[11px] tabular-nums">
                  {branches.length}
                </span>
              )}
              <ChevronDown
                className="size-4"
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            aria-label={t("branches")}
            className="w-80 max-w-[calc(100vw-2rem)] gap-2 rounded-lg border border-border p-3 text-[13px] shadow-lg ring-0"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{t("branches")}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="rounded-md"
                aria-label={t("refresh")}
                title={t("refresh")}
                disabled={loading}
                onClick={() => void reload()}
              >
                <RefreshCw
                  className="size-4"
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
              </Button>
            </div>
            {loading && (
              <p role="status" className="text-muted-foreground">
                {t("loading")}
              </p>
            )}
            {loadError && (
              <div
                role="alert"
                className="flex items-center justify-between gap-2 text-destructive"
              >
                <span className="min-w-0 break-words">
                  {t("loadFailed")} {loadError}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-md"
                  disabled={loading}
                  onClick={() => void reload()}
                >
                  {t("retry")}
                </Button>
              </div>
            )}
            {branches.length > 0 && (
              <ul
                aria-label={t("branches")}
                className="max-h-64 overflow-y-auto"
              >
                {branches.map((info) => (
                  <li key={info.id} className="flex min-h-9 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 min-w-0 flex-1 justify-start rounded-md px-2 text-[13px]"
                      title={info.title}
                      onClick={() => {
                        setMenuOpen(false)
                        onOpenConversation(info.branchConversationId)
                      }}
                    >
                      <span className="truncate">
                        {info.title.replace(/^\[(Research|Fork)\]\s*/, "")}
                      </span>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="rounded-md"
                      aria-label={t("split")}
                      title={t("split")}
                      onClick={() => {
                        setMenuOpen(false)
                        onOpenConversation(info.branchConversationId, true)
                      }}
                    >
                      <Columns2
                        className="size-4"
                        strokeWidth={1.5}
                        aria-hidden="true"
                      />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {!loading && !loadError && branches.length === 0 && (
              <p className="text-muted-foreground">{t("empty")}</p>
            )}
            <div className="space-y-1 border-t border-border pt-2 text-[11px] text-muted-foreground">
              {unavailable && <p>{unavailable}</p>}
              <p>{t("boundary")}</p>
              <p>{t("sharedDirectory")}</p>
            </div>
          </PopoverContent>
        </Popover>
      </div>
      {!summaryOpen && (operationError || notice === "returned") && (
        <div className="space-y-1 px-4 pb-2">{operationFeedback}</div>
      )}
      {onForkFromPrompt && (
        <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
          {pickerOpen && (
            <PromptForkPicker
              conversationId={conversationId}
              onSelect={async (turnId, text, fromStart, sourcePrompt) => {
                const succeeded = await onForkFromPrompt(
                  turnId,
                  text,
                  fromStart,
                  sourcePrompt
                )
                if (succeeded) setPickerOpen(false)
                return succeeded
              }}
              onTail={() => {
                setPickerOpen(false)
                void create()
              }}
            />
          )}
        </Dialog>
      )}
      {ownBranch && (
        <Dialog
          open={summaryOpen}
          onOpenChange={(open) => {
            if (saving) return
            setSummaryOpen(open)
            // 关闭即停止整理；编辑稿保留，隐藏的生成请求不能在之后覆盖它。
            if (!open && generateRequest.current) void cancel()
          }}
        >
          <DialogContent
            showCloseButton={false}
            className="max-w-xl gap-4 rounded-lg p-4"
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              summaryTrigger.current?.focus()
            }}
          >
            <DialogHeader className="pr-10">
              <DialogTitle className="text-[15px]">
                {t("bringBack")}
              </DialogTitle>
              <DialogDescription className="text-[13px]">
                {t("summaryHelp")}
              </DialogDescription>
            </DialogHeader>
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute top-3 right-3 rounded-md"
                aria-label={t("close")}
                disabled={saving}
              >
                <X className="size-4" strokeWidth={1.5} aria-hidden="true" />
              </Button>
            </DialogClose>
            <p
              className="truncate text-[11px] text-muted-foreground"
              title={ownBranch.sourceTitle}
            >
              {t("source")}: {ownBranch.sourceTitle}
            </p>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={summaryId} className="text-[13px] font-medium">
                  {t("summary")}
                </label>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {t("characterCount", {
                    count: summaryLength,
                    max: RESEARCH_BRANCH_MAX_SUMMARY_CHARS,
                  })}
                </span>
              </div>
              <Textarea
                id={summaryId}
                value={draft.text}
                rows={8}
                className="max-h-80 min-h-48 resize-y rounded-md px-3 py-2 text-[13px] md:text-[13px]"
                placeholder={t("summaryPlaceholder")}
                disabled={generating || saving}
                aria-invalid={tooLong}
                aria-describedby={tooLong ? `${summaryId}-error` : undefined}
                onChange={(event) => {
                  updateDraft({ ...draftRef.current, text: event.target.value })
                  setNotice(null)
                }}
              />
              {tooLong && (
                <p
                  id={`${summaryId}-error`}
                  className="text-[11px] text-destructive"
                >
                  {t("tooLong")}
                </p>
              )}
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-md text-[13px]"
                  disabled={busy || working}
                  onClick={() => void generate()}
                >
                  {t("generate")}
                </Button>
                {generating && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 rounded-md text-[13px]"
                    onClick={() => void cancel()}
                  >
                    {t("cancel")}
                  </Button>
                )}
                {dirty && (
                  <span className="text-[11px] text-muted-foreground">
                    {t("unsaved")}
                  </span>
                )}
              </div>
              {generating && (
                <p role="status" className="text-[11px] text-muted-foreground">
                  {t("generating")}
                </p>
              )}
            </div>
            {operationFeedback}
            <DialogFooter className="border-t border-border pt-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 rounded-md text-[13px]"
                disabled={working || !dirty || tooLong}
                onClick={() => void save(false)}
              >
                {t(saving ? "saving" : "save")}
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-8 rounded-md text-[13px]"
                disabled={working || !draft.text.trim() || tooLong}
                onClick={() => void save(true)}
              >
                {t("returnSummary")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}

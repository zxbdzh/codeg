"use client"

import { useCallback, useEffect, useId, useRef, useState } from "react"
import { ChevronDown, ChevronRight, GitBranch, RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import {
  cancelResearchBranchSummary,
  createResearchBranch,
  generateResearchBranchSummary,
  listResearchBranches,
  RESEARCH_BRANCH_MAX_SUMMARY_CHARS,
  saveResearchBranchSummary,
  type ResearchBranchInfo,
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
  canCreate: boolean
  busy: boolean
  onOpenConversation: (conversationId: number, split?: boolean) => void
  onReturnSummary: (sourceConversationId: number, summary: string) => void
  onCreated?: (info: ResearchBranchInfo) => void
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
  canCreate,
  busy,
  onOpenConversation,
  onReturnSummary,
  onCreated,
}: ResearchBranchPanelProps & { conversationId: number }) {
  const t = useTranslations("ResearchBranch")
  const panelId = useId()
  const summaryId = useId()
  const [expanded, setExpanded] = useState(false)
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
    !canCreate ||
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
      onOpenConversation(info.branchConversationId, true)
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
      if (handoff)
        onReturnSummary(ownBranch.sourceConversationId, saved.summary)
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

  const unavailable = busy
    ? t("waitForCompletion")
    : !canCreate
      ? t("unsupported")
      : !connectionId
        ? t("connectionRequired")
        : null

  return (
    <section
      className="shrink-0 border-b border-border text-[13px]"
      aria-label={t("title")}
    >
      <div className="flex min-h-9 items-center gap-2 px-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-2 rounded-md px-2 text-[13px]"
          aria-expanded={expanded}
          aria-controls={panelId}
          disabled={
            !expanded &&
            relations.length === 0 &&
            unavailable !== null &&
            loadError === null
          }
          title={unavailable ?? undefined}
          onClick={() => setExpanded((current) => !current)}
        >
          <GitBranch className="size-4" strokeWidth={1.5} aria-hidden="true" />
          {t("title")}
          {expanded ? (
            <ChevronDown className="size-4" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-4" aria-hidden="true" />
          )}
        </Button>
        {unavailable && (
          <span
            className="min-w-0 truncate text-[11px] text-muted-foreground"
            title={unavailable}
          >
            {unavailable}
          </span>
        )}
      </div>
      {expanded && (
        <div
          id={panelId}
          className="max-h-[min(60vh,36rem)] space-y-3 overflow-y-auto px-4 pb-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
            <p className="min-w-0 flex-1 text-[11px] text-muted-foreground">
              {t("boundary")}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 rounded-md"
              disabled={loading}
              onClick={() => void reload()}
            >
              <RefreshCw
                className="size-4"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              {t("refresh")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 rounded-md"
              disabled={createDisabled}
              onClick={() => void create()}
            >
              {t(creating ? "creating" : "create")}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t("sharedDirectory")}
          </p>
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
          {ownBranch && (
            <div className="space-y-2">
              <div className="flex min-h-9 items-center gap-2 border-b border-border">
                <span className="shrink-0 text-muted-foreground">
                  {t("source")}
                </span>
                <span
                  className="min-w-0 flex-1 truncate"
                  title={ownBranch.sourceTitle}
                >
                  {ownBranch.sourceTitle}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-md"
                  onClick={() =>
                    onOpenConversation(ownBranch.sourceConversationId)
                  }
                >
                  {t("returnToSource")}
                </Button>
              </div>
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={summaryId} className="font-medium">
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
                rows={5}
                className="max-h-64 min-h-28 resize-y rounded-md px-3 py-2 text-[13px] md:text-[13px]"
                placeholder={t("summaryPlaceholder")}
                disabled={generating || saving}
                aria-invalid={tooLong}
                aria-describedby={`${summaryId}-help`}
                onChange={(event) => {
                  updateDraft({ ...draftRef.current, text: event.target.value })
                  setNotice(null)
                }}
              />
              <p
                id={`${summaryId}-help`}
                className={
                  tooLong
                    ? "text-[11px] text-destructive"
                    : "text-[11px] text-muted-foreground"
                }
              >
                {t(tooLong ? "tooLong" : "summaryHelp")}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-md"
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
                    className="h-8 rounded-md"
                    onClick={() => void cancel()}
                  >
                    {t("cancel")}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-md"
                  disabled={working || !dirty || tooLong}
                  onClick={() => void save(false)}
                >
                  {t(saving ? "saving" : "save")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-8 rounded-md"
                  disabled={working || !draft.text.trim() || tooLong}
                  onClick={() => void save(true)}
                >
                  {t("returnSummary")}
                </Button>
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
          )}
          {branches.length > 0 && (
            <ul aria-label={t("branches")} className="divide-y divide-border">
              {branches.map((info) => (
                <li key={info.id} className="flex min-h-10 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate" title={info.title}>
                    {info.title}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 rounded-md"
                    onClick={() =>
                      onOpenConversation(info.branchConversationId)
                    }
                  >
                    {t("open")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 rounded-md"
                    onClick={() =>
                      onOpenConversation(info.branchConversationId, true)
                    }
                  >
                    {t("split")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {!loading && !loadError && relations.length === 0 && (
            <p className="text-muted-foreground">{t("empty")}</p>
          )}
          {operationError && (
            <div
              role="alert"
              className="flex items-center justify-between gap-2 text-destructive"
            >
              <span className="min-w-0 break-words">
                {operationError.message}
              </span>
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
        </div>
      )}
    </section>
  )
}

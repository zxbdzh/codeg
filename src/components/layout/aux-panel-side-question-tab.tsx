"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import {
  Check,
  Copy,
  Loader2,
  MessageCircleQuestionMark,
  FileText,
  RotateCcw,
  Send,
  Square,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
import {
  ComposerSurface,
  ComposerToolbar,
} from "@/components/chat/composer/composer-surface"
import {
  RichComposer,
  type RichComposerHandle,
} from "@/components/chat/composer/rich-composer"
import { ComposerImageThumbnails } from "@/components/chat/composer/composer-image-thumbnails"
import { composerEditableMinHeight } from "@/components/chat/composer/composer-sizing"
import { useComposerChromeFocus } from "@/components/chat/composer/use-composer-chrome-focus"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  useOptionalConnectionStore,
  type ConnectionState,
} from "@/contexts/acp-connections-context"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useTabStore } from "@/contexts/tab-context"
import { filesFromClipboard } from "@/lib/clipboard-images"
import {
  SIDE_ATTACHMENT_MAX_TEXT_CHARS,
  readSideQuestionAttachment,
  validateSideAttachmentBatch,
  type SideAttachmentError,
  type SideQuestionDraftAttachment,
} from "@/lib/side-question-attachments"
import { copyTextToClipboard } from "@/lib/utils"
import {
  buildSideQuestionContext,
  SIDE_QUESTION_MAX_QUESTION_CHARS,
  unicodeLength,
} from "@/lib/side-question"
import { getTimelineTurns } from "@/stores/conversation-runtime-store"
import {
  EMPTY_SIDE_QUESTION,
  sideQuestionSourceKey,
  useSideQuestionStore,
} from "@/stores/side-question-store"

function supportsSideQuestion(agentType: string): boolean {
  return agentType === "claude_code" || agentType === "codex"
}

function canFollowConnection(
  connection: ConnectionState | undefined,
  agentType: string
): connection is ConnectionState {
  return Boolean(
    supportsSideQuestion(agentType) &&
    connection?.agentType === agentType &&
    connection.connectionId &&
    (connection.status === "connected" || connection.status === "prompting") &&
    connection.selectorsReady &&
    !connection.configStale &&
    connection.configOptions?.some(
      (option) =>
        (option.id === "model" || option.category === "model") &&
        option.kind.type === "select" &&
        option.kind.current_value.trim().length > 0
    )
  )
}

function AttachmentList({
  attachments,
  onRemove,
  removeLabel,
}: {
  attachments: readonly SideQuestionDraftAttachment[]
  onRemove?: (id: string) => void
  removeLabel: string
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <ComposerImageThumbnails
        attachments={attachments.flatMap((attachment) =>
          attachment.type === "image" ? [{ ...attachment, uri: null }] : []
        )}
        onRemove={onRemove}
      />
      {attachments
        .filter((attachment) => attachment.type === "text")
        .map((attachment) => (
          <div
            key={attachment.id}
            className="relative flex min-w-0 max-w-full items-center gap-2 rounded-md border border-border bg-muted/20 p-1.5"
          >
            <FileText
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span
              className="max-w-32 truncate text-[11px]"
              title={attachment.name}
            >
              {attachment.name}
            </span>
            {onRemove && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-6 shrink-0 rounded"
                aria-label={`${removeLabel}: ${attachment.name}`}
                onClick={() => onRemove(attachment.id)}
              >
                <X className="size-3.5" aria-hidden />
              </Button>
            )}
          </div>
        ))}
    </div>
  )
}

export function SideQuestionTab() {
  const t = useTranslations("Folder.sideQuestion")
  const [copiedAnswer, setCopiedAnswer] = useState<string | null>(null)
  const [readingAttachments, setReadingAttachments] = useState(false)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const intake = useRef<object | null>(null)
  const editorRef = useRef<RichComposerHandle>(null)
  const chromeFocus = useComposerChromeFocus(editorRef)
  const { isOpen, activeTab } = useAuxPanelContext()
  const active = isOpen && activeTab === "side_question"
  const tabs = useTabStore((state) => state.tabs)
  const activeTabId = useTabStore((state) => state.activeTabId)
  const source = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId]
  )
  const sourceKey = source ? sideQuestionSourceKey(source) : null
  const sourceTabId = source?.id ?? null
  const connectionStore = useOptionalConnectionStore()
  const subscribeConnection = useCallback(
    (listener: () => void) =>
      sourceTabId && connectionStore
        ? connectionStore.subscribeKey(sourceTabId, listener)
        : () => {},
    [connectionStore, sourceTabId]
  )
  const getConnection = useCallback(
    () =>
      sourceTabId ? connectionStore?.getConnection(sourceTabId) : undefined,
    [connectionStore, sourceTabId]
  )
  const connection = useSyncExternalStore(
    subscribeConnection,
    getConnection,
    () => undefined
  )
  const connectionReady = Boolean(
    source && canFollowConnection(connection, source.agentType)
  )
  const modelOption = connectionReady
    ? connection?.configOptions?.find(
        (option) => option.id === "model" || option.category === "model"
      )
    : undefined
  const modelKind = modelOption?.kind
  const modelName =
    modelKind?.type === "select"
      ? ([
          ...modelKind.options,
          ...modelKind.groups.flatMap((group) => group.options),
        ].find((option) => option.value === modelKind.current_value)?.name ??
        modelKind.current_value)
      : null
  const unavailable = !source
    ? null
    : !supportsSideQuestion(source.agentType)
      ? t("unsupported")
      : connection?.agentType !== source.agentType ||
          !connection.connectionId ||
          (connection.status !== "connected" &&
            connection.status !== "prompting")
        ? t("connectionRequired")
        : !connectionReady
          ? t("modelPending")
          : null
  const entry = useSideQuestionStore((state) =>
    sourceKey
      ? (state.bySource[sourceKey] ?? EMPTY_SIDE_QUESTION)
      : EMPTY_SIDE_QUESTION
  )
  const loading = entry.status === "loading"
  const syncEditor = useCallback(() => {
    if (editorRef.current && editorRef.current.getText() !== entry.question)
      editorRef.current.setText(entry.question)
  }, [entry.question])
  useEffect(syncEditor, [syncEditor, sourceKey])
  const questionLength = unicodeLength(entry.question.trim())
  const tooLong = questionLength > SIDE_QUESTION_MAX_QUESTION_CHARS
  const canAsk =
    active &&
    connectionReady &&
    sourceKey !== null &&
    (questionLength > 0 || entry.attachments.length > 0) &&
    !tooLong &&
    !loading &&
    !readingAttachments

  // 隐藏、切页和卸载只影响展示；请求由 Store 持有，显式停止、重置话题或切换后端才取消。

  useEffect(() => {
    setCopiedAnswer(null)
  }, [sourceKey, entry.result])

  useEffect(() => {
    setReadingAttachments(false)
    setDraggingFiles(false)
    return () => {
      intake.current = null
    }
  }, [sourceKey, active])

  const addFiles = async (files: File[]) => {
    if (!active || !sourceKey || !files.length || loading || intake.current)
      return
    const targetKey = sourceKey
    const current =
      useSideQuestionStore.getState().bySource[targetKey]?.attachments ?? []
    const limitError = validateSideAttachmentBatch(current, files)
    if (limitError) {
      toast.error(t(limitError))
      return
    }
    const job = {}
    intake.current = job
    setReadingAttachments(true)
    try {
      const attachments = await Promise.all(
        files.map(readSideQuestionAttachment)
      )
      // 读取文件时可能切会话或清空；旧读取不能重新填回已撤销的附件。
      if (intake.current !== job) return
      const latest =
        useSideQuestionStore.getState().bySource[targetKey]?.attachments ?? []
      const conflict = validateSideAttachmentBatch(
        latest,
        attachments.map((item) => ({ size: item.bytes }))
      )
      const textChars = [...latest, ...attachments].reduce(
        (sum, item) =>
          sum + (item.type === "text" ? unicodeLength(item.text) : 0),
        0
      )
      if (conflict || textChars > SIDE_ATTACHMENT_MAX_TEXT_CHARS)
        throw new Error(conflict ?? "attachmentTooLarge")
      useSideQuestionStore.getState().addAttachments(targetKey, attachments)
    } catch (error) {
      if (intake.current !== job) return
      const key =
        error instanceof Error &&
        [
          "unsupportedFile",
          "attachmentTooLarge",
          "tooManyAttachments",
        ].includes(error.message)
          ? (error.message as SideAttachmentError)
          : "attachmentReadFailed"
      toast.error(t(key))
    } finally {
      if (intake.current === job) {
        intake.current = null
        setReadingAttachments(false)
      }
    }
  }

  const ask = () => {
    if (!canAsk || !sourceKey || !connectionStore || intake.current) return
    const tabState = useTabStore.getState()
    const currentSource = tabState.tabs.find(
      (tab) => tab.id === tabState.activeTabId
    )
    // 点击与渲染之间可能换标签、代理或重连，不能沿用旧闭包里的连接身份。
    if (!currentSource || sideQuestionSourceKey(currentSource) !== sourceKey)
      return
    const currentConnection = connectionStore.getConnection(currentSource.id)
    if (!canFollowConnection(currentConnection, currentSource.agentType)) return
    const runtimeId =
      currentSource.runtimeConversationId ?? currentSource.conversationId
    // 点击发送时再取快照，随后主线的新输出不会改变本次旁问的引用范围。
    const context =
      runtimeId == null
        ? []
        : buildSideQuestionContext(getTimelineTurns(runtimeId))
    void useSideQuestionStore.getState().ask(sourceKey, context, {
      sourceConnectionId: currentConnection.connectionId,
      sourceConversationId: currentSource.conversationId,
      sourceAgentType: currentSource.agentType,
    })
  }

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col text-[13px] select-text"
      aria-label={t("title")}
      onDragOver={(event) => {
        if (
          !active ||
          !source ||
          !Array.from(event.dataTransfer.types).includes("Files")
        )
          return
        event.preventDefault()
        event.stopPropagation()
        setDraggingFiles(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDraggingFiles(false)
      }}
      onDrop={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return
        event.preventDefault()
        event.stopPropagation()
        setDraggingFiles(false)
        void addFiles(Array.from(event.dataTransfer.files))
      }}
    >
      <div className="shrink-0 border-b border-border">
        <div className="flex h-10 items-center justify-between gap-2 px-3">
          <span className="flex items-center gap-2 font-medium">
            <MessageCircleQuestionMark
              className="size-4 text-muted-foreground"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            {t("title")}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 rounded-md text-muted-foreground"
            aria-label={t("clear")}
            title={t("clear")}
            disabled={
              !sourceKey ||
              (!entry.question &&
                entry.turns.length === 0 &&
                entry.attachments.length === 0 &&
                !entry.selection &&
                !entry.result &&
                !entry.error &&
                !readingAttachments &&
                !loading)
            }
            onClick={() => {
              intake.current = null
              setReadingAttachments(false)
              if (sourceKey) useSideQuestionStore.getState().clear(sourceKey)
              setCopiedAnswer(null)
            }}
          >
            <RotateCcw
              className="size-4"
              strokeWidth={1.5}
              aria-hidden="true"
            />
          </Button>
        </div>
        <div className="space-y-1.5 px-3 pb-3 text-[11px] text-muted-foreground">
          <p className="truncate" title={modelName ?? undefined}>
            {modelName
              ? t("followingModel", { model: modelName })
              : t("followCurrent")}
          </p>
          {source && (
            <p className="truncate" title={source.title}>
              {t("source")}: {source.title}
            </p>
          )}
          {unavailable && (
            <p role="status" className="leading-relaxed text-foreground/70">
              {unavailable}
            </p>
          )}
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {!source ? (
            <p className="text-muted-foreground">{t("noActiveSession")}</p>
          ) : (
            <>
              {entry.selection && (
                <div className="rounded-md border border-border bg-muted/30 px-2.5 py-2">
                  <div className="flex items-start gap-1">
                    <details className="min-w-0 flex-1">
                      <summary className="cursor-pointer text-[11px] text-muted-foreground">
                        {t("selectionStats", {
                          chars: unicodeLength(entry.selection),
                        })}
                      </summary>
                      <p className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">
                        {entry.selection}
                      </p>
                    </details>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="-mt-1 size-6 shrink-0 rounded text-muted-foreground"
                      aria-label={t("useRecent")}
                      title={t("useRecent")}
                      onClick={() => {
                        if (sourceKey)
                          useSideQuestionStore
                            .getState()
                            .useRecentContext(sourceKey)
                      }}
                    >
                      <X
                        className="size-3.5"
                        strokeWidth={1.5}
                        aria-hidden="true"
                      />
                    </Button>
                  </div>
                </div>
              )}
              {entry.turns.map((turn) => (
                <div key={turn.id} className="space-y-4">
                  {turn.question && (
                    <Message from="user">
                      <MessageContent className="whitespace-pre-wrap break-words">
                        {turn.question}
                      </MessageContent>
                    </Message>
                  )}
                  {turn.attachments.length > 0 && (
                    <AttachmentList
                      attachments={turn.attachments}
                      removeLabel={t("removeAttachment")}
                    />
                  )}
                  {turn.status === "loading" && (
                    <div
                      role="status"
                      className="flex items-center gap-2 text-muted-foreground"
                    >
                      <Loader2
                        className="size-4 animate-spin motion-reduce:animate-none"
                        strokeWidth={1.5}
                        aria-hidden
                      />
                      {t("asking")}
                    </div>
                  )}
                  {turn.status === "cancelled" && (
                    <p role="status" className="text-muted-foreground">
                      {t("cancelled")}
                    </p>
                  )}
                  {turn.error && (
                    <p
                      role="alert"
                      className="whitespace-pre-wrap break-words text-destructive"
                    >
                      {turn.error}
                    </p>
                  )}
                  {turn.result && (
                    <Message from="assistant" aria-label={t("answer")}>
                      <MessageContent>
                        <MessageResponse>{turn.result.answer}</MessageResponse>
                      </MessageContent>
                      <div className="flex min-w-0 items-center justify-between gap-2 border-t border-border/60 pt-2">
                        <p className="text-[11px] tabular-nums text-muted-foreground">
                          {turn.result.selectionChars > 0
                            ? t("selectionStats", {
                                chars: turn.result.selectionChars,
                              })
                            : t("contextStats", {
                                messages: turn.result.contextMessages,
                                chars: turn.result.contextChars,
                              })}
                        </p>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="size-7 shrink-0 rounded-md text-muted-foreground"
                          aria-label={
                            copiedAnswer === turn.result.answer
                              ? t("copied")
                              : t("copyAnswer")
                          }
                          title={t("copyAnswer")}
                          onClick={async () => {
                            const answer = turn.result?.answer
                            if (!answer) return
                            try {
                              if (!(await copyTextToClipboard(answer))) {
                                toast.error(t("copyFailed"))
                                return
                              }
                              setCopiedAnswer(answer)
                            } catch {
                              toast.error(t("copyFailed"))
                            }
                          }}
                        >
                          {copiedAnswer === turn.result.answer ? (
                            <Check
                              className="size-4"
                              strokeWidth={1.5}
                              aria-hidden="true"
                            />
                          ) : (
                            <Copy
                              className="size-4"
                              strokeWidth={1.5}
                              aria-hidden="true"
                            />
                          )}
                        </Button>
                      </div>
                    </Message>
                  )}
                </div>
              ))}
              {entry.status === "idle" && (
                <div className="space-y-2 py-3 leading-relaxed text-muted-foreground">
                  <p className="font-medium text-foreground/85">{t("empty")}</p>
                  <p className="text-[11px]">{t("scopeHint")}</p>
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>
      <form
        className="shrink-0 p-3"
        onSubmit={(event) => {
          event.preventDefault()
          ask()
        }}
      >
        <ComposerSurface {...chromeFocus} dragActive={draggingFiles}>
          {draggingFiles && (
            <p role="status" className="text-[11px] text-muted-foreground">
              {t("dropFiles")}
            </p>
          )}
          {entry.attachments.length > 0 && (
            <div className="px-3 pt-2">
              <AttachmentList
                attachments={entry.attachments}
                removeLabel={t("removeAttachment")}
                onRemove={
                  loading
                    ? undefined
                    : (id) => {
                        if (sourceKey)
                          useSideQuestionStore
                            .getState()
                            .removeAttachment(sourceKey, id)
                      }
                }
              />
            </div>
          )}
          {readingAttachments && (
            <p role="status" className="text-[11px] text-muted-foreground">
              {t("readingAttachments")}
            </p>
          )}
          <RichComposer
            key={sourceKey ?? "empty"}
            ref={editorRef}
            defaultText={entry.question}
            onReady={syncEditor}
            ariaLabel={t("question")}
            placeholder={t("placeholder")}
            disabled={!source}
            className={`grow max-h-52 ${composerEditableMinHeight(false, entry.attachments.length > 0)}`}
            onChange={(text) => {
              if (sourceKey)
                useSideQuestionStore.getState().setQuestion(sourceKey, text)
            }}
            onSubmit={ask}
            submitShortcut="mod+enter"
            newlineShortcut="enter"
            onPasteFiles={(event) => {
              const files = filesFromClipboard(event.clipboardData)
              if (!files.length) return false
              event.preventDefault()
              event.stopPropagation()
              void addFiles(files)
              return true
            }}
            onDropFiles={(event) => {
              if (
                !Array.from(event.dataTransfer?.types ?? []).includes("Files")
              )
                return false
              event.preventDefault()
              event.stopPropagation()
              setDraggingFiles(false)
              void addFiles(Array.from(event.dataTransfer?.files ?? []))
              return true
            }}
          />
          {tooLong && (
            <p role="alert" className="text-xs text-destructive">
              {t("questionTooLong")}
            </p>
          )}
          <ComposerToolbar className="justify-end">
            {loading ? (
              <Button
                type="button"
                variant="destructive"
                size="icon"
                className="h-8 w-8"
                aria-label={t("cancel")}
                title={t("cancel")}
                onClick={(event) => {
                  // 取消后同一 DOM 会变为提交按钮，必须阻止本次点击的默认提交。
                  event.preventDefault()
                  if (sourceKey)
                    useSideQuestionStore.getState().cancel(sourceKey)
                }}
              >
                <Square className="size-4" aria-hidden />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                className="h-8 w-8"
                aria-label={t("send")}
                title={t("shortcut")}
                disabled={!canAsk}
              >
                <Send className="size-4" aria-hidden />
              </Button>
            )}
          </ComposerToolbar>
        </ComposerSurface>
      </form>
    </section>
  )
}

"use client"

import { useEffect, useMemo } from "react"
import { Loader2, Send, Square } from "lucide-react"
import { useTranslations } from "next-intl"

import { MessageResponse } from "@/components/ai-elements/message"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useTabStore } from "@/contexts/tab-context"
import { useImeGuard } from "@/hooks/use-ime-guard"
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

export function SideQuestionTab() {
  const t = useTranslations("Folder.sideQuestion")
  const ime = useImeGuard()
  const { isOpen, activeTab } = useAuxPanelContext()
  const active = isOpen && activeTab === "side_question"
  const tabs = useTabStore((state) => state.tabs)
  const activeTabId = useTabStore((state) => state.activeTabId)
  const source = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId]
  )
  const sourceKey = source ? sideQuestionSourceKey(source) : null
  const entry = useSideQuestionStore((state) =>
    sourceKey
      ? (state.bySource[sourceKey] ?? EMPTY_SIDE_QUESTION)
      : EMPTY_SIDE_QUESTION
  )
  const loading = entry.status === "loading"
  const questionLength = unicodeLength(entry.question.trim())
  const tooLong = questionLength > SIDE_QUESTION_MAX_QUESTION_CHARS
  const canAsk =
    sourceKey !== null && questionLength > 0 && !tooLong && !loading

  useEffect(() => {
    if (!sourceKey) return
    if (!active) useSideQuestionStore.getState().cancel(sourceKey)
    return () => useSideQuestionStore.getState().cancel(sourceKey)
  }, [active, sourceKey])

  const ask = () => {
    if (!canAsk || !sourceKey || !source) return
    const runtimeId = source.runtimeConversationId ?? source.conversationId
    // 点击发送时再取快照，随后主线的新输出不会改变本次旁问的引用范围。
    const context =
      runtimeId == null
        ? []
        : buildSideQuestionContext(getTimelineTurns(runtimeId))
    void useSideQuestionStore.getState().ask(sourceKey, context)
  }

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col text-[13px] select-text"
      aria-label={t("title")}
    >
      <div className="shrink-0 space-y-2 border-b border-border px-3 py-3">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="font-medium">{t("engine")}</span>
          <a
            href="/settings/collaboration/#side-question-settings"
            className="shrink-0 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {t("settings.open")}
          </a>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("scopeHint")}
        </p>
        {source && (
          <p
            className="truncate text-xs text-muted-foreground"
            title={source.title}
          >
            {t("source")}: {source.title}
          </p>
        )}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {!source ? (
            <p className="text-muted-foreground">{t("noActiveSession")}</p>
          ) : (
            <>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {entry.selection ? t("selectionHint") : t("contextHint")}
              </p>
              {entry.selection && (
                <details className="rounded-md border border-border p-2">
                  <summary className="cursor-pointer text-xs">
                    {t("selectionStats", {
                      chars: unicodeLength(entry.selection),
                    })}
                  </summary>
                  <p className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">
                    {entry.selection}
                  </p>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="mt-2"
                    onClick={() => {
                      if (sourceKey)
                        useSideQuestionStore
                          .getState()
                          .useRecentContext(sourceKey)
                    }}
                  >
                    {t("useRecent")}
                  </Button>
                </details>
              )}
              {entry.askedQuestion && (
                <p className="whitespace-pre-wrap break-words border-s-2 border-border ps-3">
                  {entry.askedQuestion}
                </p>
              )}
              {loading && (
                <div
                  role="status"
                  className="flex items-center gap-2 text-muted-foreground"
                >
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  {t("asking")}
                </div>
              )}
              {entry.status === "cancelled" && (
                <p role="status" className="text-muted-foreground">
                  {t("cancelled")}
                </p>
              )}
              {entry.error && (
                <p
                  role="alert"
                  className="whitespace-pre-wrap break-words text-destructive"
                >
                  {entry.error}
                </p>
              )}
              {entry.result && (
                <div className="space-y-3" aria-label={t("answer")}>
                  <MessageResponse>{entry.result.answer}</MessageResponse>
                  <p className="text-[11px] text-muted-foreground">
                    {entry.result.selectionChars > 0
                      ? t("selectionStats", {
                          chars: entry.result.selectionChars,
                        })
                      : t("contextStats", {
                          messages: entry.result.contextMessages,
                          chars: entry.result.contextChars,
                        })}
                  </p>
                </div>
              )}
              {entry.status === "idle" && (
                <p className="text-muted-foreground">{t("empty")}</p>
              )}
            </>
          )}
        </div>
      </ScrollArea>
      <form
        className="shrink-0 space-y-2 border-t border-border p-3"
        onSubmit={(event) => {
          event.preventDefault()
          ask()
        }}
      >
        <label className="sr-only" htmlFor="side-question-input">
          {t("question")}
        </label>
        <Textarea
          id="side-question-input"
          value={entry.question}
          placeholder={t("placeholder")}
          disabled={!source}
          className="min-h-24 rounded-md px-2 py-2 text-[13px]"
          {...ime.props}
          onChange={(event) => {
            if (sourceKey)
              useSideQuestionStore
                .getState()
                .setQuestion(sourceKey, event.target.value)
          }}
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              (!event.ctrlKey && !event.metaKey) ||
              ime.isComposing(event)
            )
              return
            event.preventDefault()
            event.stopPropagation()
            ask()
          }}
          aria-invalid={tooLong}
        />
        {tooLong && (
          <p role="alert" className="text-xs text-destructive">
            {t("questionTooLong")}
          </p>
        )}
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            {t("shortcut")}
          </span>
          {loading ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-md"
              onClick={(event) => {
                // 取消后同一 DOM 会变为提交按钮，必须阻止本次点击的默认提交。
                event.preventDefault()
                if (sourceKey) useSideQuestionStore.getState().cancel(sourceKey)
              }}
            >
              <Square className="size-3" aria-hidden />
              {t("cancel")}
            </Button>
          ) : (
            <Button
              type="submit"
              size="sm"
              className="rounded-md"
              disabled={!canAsk}
            >
              <Send className="size-3.5" aria-hidden />
              {t("send")}
            </Button>
          )}
        </div>
      </form>
    </section>
  )
}

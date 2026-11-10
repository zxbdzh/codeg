"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DialogContent,
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { getFolderConversation } from "@/lib/api"
import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import { unescapeComposerText } from "@/lib/composer-copy-text"
import type { MessageTurn } from "@/lib/types"
import {
  snapshotForkPrompt,
  type ForkPromptSnapshot,
} from "@/lib/research-branch"

export function PromptForkPicker({
  conversationId,
  onSelect,
  onTail,
}: {
  conversationId: number
  onSelect: (
    turnId: string,
    text: string,
    fromStart?: boolean,
    sourcePrompt?: ForkPromptSnapshot
  ) => Promise<boolean>
  onTail: () => void
}) {
  const t = useTranslations("ResearchBranch")
  const [turns, setTurns] = useState<MessageTurn[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [pending, setPending] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [granularity, setGranularity] = useState<"message" | "turn" | null>(
    null
  )

  useEffect(() => {
    let current = true
    void getFolderConversation(conversationId).then(
      (detail) => {
        if (current) {
          setTurns(detail.turns)
          const agent = detail.summary?.agent_type
          setGranularity(
            agent === "claude_code"
              ? "message"
              : agent === "codex" || agent === "deepseek"
                ? "turn"
                : null
          )
        }
      },
      (reason: unknown) => {
        if (current)
          setError(
            extractAppCommandError(reason)?.message ?? toErrorMessage(reason)
          )
      }
    )
    return () => {
      current = false
    }
  }, [conversationId, attempt])

  const prompts = (turns ?? []).flatMap((turn, index) => {
    if (turn.role !== "user") return []
    const text = unescapeComposerText(
      turn.blocks
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n")
    )
    let hasAnchor = false
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      if (turns?.[previous].role === "user") break
      if (turns?.[previous].role === "assistant") {
        hasAnchor = true
        break
      }
    }
    const textOnly =
      turn.blocks.length > 0 &&
      turn.blocks.every((block) => block.type === "text") &&
      text.trim().length > 0
    const fromStart = !(turns ?? [])
      .slice(0, index)
      .some((previous) => previous.role !== "system")
    return [
      {
        id: turn.id,
        text,
        snapshot: snapshotForkPrompt(turn),
        number:
          (turns ?? []).slice(0, index).filter((item) => item.role === "user")
            .length + 1,
        fromStart,
        supported: (hasAnchor || fromStart) && textOnly,
      },
    ]
  })
  const filtered = prompts.filter((prompt) =>
    prompt.text.toLocaleLowerCase().includes(search.toLocaleLowerCase().trim())
  )

  return (
    <DialogContent
      showCloseButton={false}
      className="max-w-xl gap-3 rounded-lg p-4"
      onEscapeKeyDown={(event) => {
        if (pending) event.preventDefault()
      }}
      onPointerDownOutside={(event) => {
        if (pending) event.preventDefault()
      }}
    >
      <DialogHeader>
        <DialogTitle className="text-[15px]">{t("choosePrompt")}</DialogTitle>
        <DialogDescription className="text-[13px]">
          {t("choosePromptHelp")}
        </DialogDescription>
      </DialogHeader>
      {granularity && (
        <p className="text-[11px] text-muted-foreground">
          {t(granularity === "message" ? "messageBoundary" : "turnBoundary")}{" "}
          {t("sharedDirectory")}
        </p>
      )}
      <DialogClose asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute top-3 right-3 rounded-md"
          disabled={pending}
          aria-label={t("close")}
        >
          <X className="size-4" strokeWidth={1.5} aria-hidden="true" />
        </Button>
      </DialogClose>
      <Input
        className="h-8 rounded-md text-[13px]"
        aria-label={t("searchPrompts")}
        placeholder={t("searchPrompts")}
        value={search}
        disabled={pending}
        onChange={(event) => setSearch(event.target.value)}
      />
      {error ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 text-[13px] text-destructive"
        >
          <span>{error}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setError(null)
              setAttempt((value) => value + 1)
            }}
          >
            {t("retry")}
          </Button>
        </div>
      ) : turns === null ? (
        <p role="status" className="text-[13px] text-muted-foreground">
          {t("loading")}
        </p>
      ) : (
        <div className="max-h-[min(50vh,28rem)] overflow-y-auto">
          <ul aria-label={t("yourPrompts")} className="divide-y divide-border">
            {filtered.map((prompt) => (
              <li key={prompt.id}>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto w-full items-start justify-start gap-3 rounded-md px-2 py-3 text-start text-[13px] whitespace-normal"
                  disabled={pending || !prompt.supported}
                  title={
                    prompt.supported ? prompt.text : t("promptUnavailable")
                  }
                  onClick={async () => {
                    if (pending) return
                    setPending(true)
                    try {
                      await onSelect(
                        prompt.id,
                        prompt.text,
                        prompt.fromStart,
                        prompt.snapshot
                      )
                    } finally {
                      setPending(false)
                    }
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="mt-0.5 text-[11px] tabular-nums text-muted-foreground"
                  >
                    {prompt.number}
                  </span>
                  <span className="line-clamp-3 min-w-0 flex-1 break-words">
                    {prompt.text}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
          {filtered.length === 0 && (
            <p className="py-4 text-[13px] text-muted-foreground">
              {t("noPrompts")}
            </p>
          )}
        </div>
      )}
      <div className="border-t border-border pt-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 rounded-md text-[13px]"
          disabled={pending}
          onClick={onTail}
        >
          {t("fromLatest")}
        </Button>
      </div>
      {pending && (
        <p role="status" className="text-[11px] text-muted-foreground">
          {t("creating")}
        </p>
      )}
    </DialogContent>
  )
}

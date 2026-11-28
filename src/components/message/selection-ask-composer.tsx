"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { X } from "lucide-react"
import { toast } from "sonner"
import {
  MessageInput,
  type ComposerInjectContent,
} from "@/components/chat/message-input"
import { buildQuotedMarkdown } from "@/lib/message-quote"
import { getReadonlyAskCapability, type ReadonlyAskCapability } from "@/lib/api"
import { randomUUID } from "@/lib/utils"
import { toErrorMessage } from "@/lib/app-error"
import { getActiveRemoteConnectionId } from "@/lib/transport"
import {
  loadSideQuestionDraft,
  saveSideQuestionDraft,
} from "@/lib/side-question-draft"
import type {
  AgentType,
  AvailableCommandInfo,
  PromptCapabilitiesInfo,
  PromptDraft,
} from "@/lib/types"

export interface SelectionAskMention {
  conversationId: number
  label: string
}

export interface SelectionAskLiveSelectors {
  availableCommands: AvailableCommandInfo[] | null
  promptCapabilities: PromptCapabilitiesInfo
}

/** 原生副本已经带有上下文；不追加会在发送时解析成实时主线内容的引用。 */
export function buildAskComposerText(selection: string): string {
  const quoted = buildQuotedMarkdown(selection)
  return quoted ? `${quoted}\n\n` : ""
}

interface SelectionAskComposerProps {
  selection: string
  mention: SelectionAskMention
  defaultAgentType: AgentType
  live?: SelectionAskLiveSelectors | null
  defaultPath?: string
  onSubmit: (
    draft: PromptDraft,
    requestId: string,
    snapshotToken: string,
    backend: number | null
  ) => Promise<boolean>
  onClose: () => void
}

export function SelectionAskComposer({
  selection,
  mention,
  defaultAgentType,
  live,
  defaultPath,
  onSubmit,
  onClose,
}: SelectionAskComposerProps) {
  const t = useTranslations("Folder.chat.messageList")
  const tSide = useTranslations("Folder.sideQuestion")
  const [backend] = useState(() => getActiveRemoteConnectionId())
  const [recovery] = useState(() =>
    loadSideQuestionDraft(backend, "source", mention.conversationId)
  )
  const [inject, setInject] = useState<ComposerInjectContent | null>(
    recovery
      ? { handBack: recovery.draft.blocks }
      : { text: buildAskComposerText(selection), mode: "replace" }
  )
  const [capability, setCapability] = useState<ReadonlyAskCapability | null>(
    null
  )
  const [loadFailed, setLoadFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  const [sending, setSending] = useState(false)
  const pending = useRef(false)
  const requestId = useRef(recovery?.requestId ?? null)
  const handleInjectConsumed = useCallback(() => setInject(null), [])

  useEffect(() => {
    let disposed = false
    void getReadonlyAskCapability(mention.conversationId)
      .then((result) => {
        if (!disposed) {
          setCapability(result)
          setLoadFailed(false)
        }
      })
      .catch(() => {
        if (!disposed) setLoadFailed(true)
      })
    return () => {
      disposed = true
    }
  }, [mention.conversationId, revision])

  const handleSend = useCallback(
    (draft: PromptDraft) => {
      if (
        pending.current ||
        !capability?.supported ||
        backend !== getActiveRemoteConnectionId()
      )
        return false
      requestId.current ??= randomUUID()
      const id = requestId.current
      const token = randomUUID()
      if (
        !saveSideQuestionDraft(backend, "source", mention.conversationId, {
          token,
          draft,
          requestId: id,
        })
      ) {
        toast.error(tSide("draftSaveFailed"))
        return false
      }
      pending.current = true
      setSending(true)
      void (async () => {
        try {
          if (!(await onSubmit(draft, id, token, backend))) {
            setInject({ handBack: draft.blocks })
          }
        } catch (error) {
          // 创建失败时可用同一个 requestId 手动重试，避免重复创建。
          setInject({ handBack: draft.blocks })
          toast.error(tSide("createFailed"), {
            description: toErrorMessage(error),
          })
        } finally {
          pending.current = false
          setSending(false)
        }
      })()
    },
    [backend, capability, mention.conversationId, onSubmit, tSide]
  )

  return (
    <div className="relative flex flex-col gap-1.5">
      <p className="px-1 text-xs text-muted-foreground">
        {tSide("readonlyHint")}
      </p>
      {loadFailed && (
        <button
          type="button"
          className="text-xs text-destructive"
          onClick={() => setRevision((value) => value + 1)}
        >
          {tSide("loadFailed")} · {tSide("retry")}
        </button>
      )}
      {capability && !capability.supported && (
        <p role="status" className="px-1 text-xs text-muted-foreground">
          {tSide(capability.reason ?? "policyUnavailable")}
        </p>
      )}
      <MessageInput
        onSend={handleSend}
        disabled={sending || !capability?.supported}
        placeholder={t("selectionAskPlaceholder")}
        defaultPath={defaultPath}
        agentType={defaultAgentType}
        promptCapabilities={
          live?.promptCapabilities ?? {
            image: false,
            audio: false,
            embedded_context: false,
          }
        }
        modes={[]}
        configOptions={[]}
        availableCommands={[]}
        attachmentTabId={null}
        draftStorageKey={null}
        isActive
        autoFocus
        injectContent={inject}
        onInjectConsumed={handleInjectConsumed}
      />
      <button
        type="button"
        onClick={onClose}
        aria-label={t("selectionAskClose")}
        title={t("selectionAskClose")}
        className="absolute -top-2 -right-2 z-10 inline-flex size-5 items-center justify-center rounded-full border border-border bg-popover text-muted-foreground shadow-sm transition-colors hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

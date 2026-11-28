"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2, Plus } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SideQuestionDock } from "@/components/conversations/side-question-host"
import { useSideQuestionSource } from "@/hooks/use-side-question-source"
import { useLinkedConversationsState } from "@/hooks/use-ask-conversations"
import { useSideQuestionPanelStore } from "@/stores/side-question-panel-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  createReadonlyAskConversation,
  getReadonlyAskCapability,
  type ReadonlyAskCapability,
} from "@/lib/api"
import { getActiveRemoteConnectionId } from "@/lib/transport"
import { toErrorMessage } from "@/lib/app-error"
import { randomUUID } from "@/lib/utils"
import type { DbConversationSummary } from "@/lib/types"

export function SideQuestionTab() {
  const { parentId, status } = useSideQuestionSource()
  // 切换来源时立即隔离加载状态与创建按钮，迟到响应仍只归原来的主会话。
  return (
    <SideQuestionList
      key={parentId ?? "none"}
      parentId={parentId}
      sourceStatus={status}
    />
  )
}

function SideQuestionList({
  parentId,
  sourceStatus,
}: {
  parentId: number | null
  sourceStatus?: string
}) {
  const t = useTranslations("Folder.sideQuestion")
  const { rows, error, retry } = useLinkedConversationsState(parentId, "ask")
  const selectedId = useSideQuestionPanelStore((s) =>
    parentId == null ? undefined : s.selectedByParent[parentId]
  )
  const opened = useSideQuestionPanelStore((s) =>
    selectedId == null ? undefined : s.opened[selectedId]
  )
  const open = useSideQuestionPanelStore((s) => s.open)
  const folders = useAppWorkspaceStore((s) => s.allFolders)
  const [capability, setCapability] = useState<ReadonlyAskCapability | null>(
    null
  )
  const [capabilityError, setCapabilityError] = useState(false)
  const [revision, setRevision] = useState(0)
  const [creating, setCreating] = useState(false)
  const requestId = useRef<string | null>(null)
  const pending = useRef(false)
  const selected = rows?.find((row) => row.id === selectedId)

  useEffect(() => {
    if (parentId == null) return
    let cancelled = false
    void getReadonlyAskCapability(parentId)
      .then((value) => {
        if (!cancelled) {
          setCapability(value)
          setCapabilityError(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCapability(null)
          setCapabilityError(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [parentId, sourceStatus, revision])

  useEffect(() => {
    if (!selected || opened) return
    open({
      conversationId: selected.id,
      parentConversationId: parentId!,
      folderId: selected.folder_id,
      agentType: selected.agent_type,
      readonly: selected.readonly_ask === true,
      workingDir:
        folders.find((folder) => folder.id === selected.folder_id)?.path ??
        null,
    })
  }, [selected, opened, parentId, folders, open])

  function select(row: DbConversationSummary) {
    open({
      conversationId: row.id,
      parentConversationId: parentId!,
      folderId: row.folder_id,
      agentType: row.agent_type,
      readonly: row.readonly_ask === true,
      workingDir:
        folders.find((folder) => folder.id === row.folder_id)?.path ?? null,
    })
  }

  async function create() {
    if (parentId == null || pending.current || !capability?.supported) return
    const backend = getActiveRemoteConnectionId()
    pending.current = true
    setCreating(true)
    requestId.current ??= randomUUID()
    try {
      const result = await createReadonlyAskConversation(
        parentId,
        requestId.current
      )
      // 切换后端后，旧请求的结果不能写入当前后端的选择。
      if (backend !== getActiveRemoteConnectionId()) return
      open({
        ...result,
        readonly: true,
        workingDir:
          folders.find((folder) => folder.id === result.folderId)?.path ?? null,
      })
      requestId.current = null
      retry()
    } catch (cause) {
      toast.error(t("createFailed"), { description: toErrorMessage(cause) })
    } finally {
      pending.current = false
      setCreating(false)
    }
  }

  if (parentId == null)
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {t("chooseConversation")}
      </p>
    )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Select
          value={selectedId == null ? "" : String(selectedId)}
          onValueChange={(id) => {
            const row = rows?.find((item) => item.id === Number(id))
            if (row) select(row)
          }}
        >
          <SelectTrigger className="min-w-0 flex-1" aria-label={t("select")}>
            <SelectValue placeholder={t("select")} />
          </SelectTrigger>
          <SelectContent>
            {rows?.map((row) => (
              <SelectItem key={row.id} value={String(row.id)}>
                {row.title || `#${row.id}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="icon"
          variant="ghost"
          onClick={create}
          disabled={creating || !capability?.supported}
          title={t("new")}
          aria-label={t("new")}
        >
          {creating ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
        </Button>
      </div>
      {(error != null || capabilityError) && (
        <div role="alert" className="px-3 py-2 text-sm text-destructive">
          {t("loadFailed")}{" "}
          <Button
            variant="link"
            size="sm"
            onClick={() => {
              retry()
              setRevision((value) => value + 1)
            }}
          >
            {t("retry")}
          </Button>
        </div>
      )}
      {capability && !capability.supported && (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {t(capability.reason ?? "policyUnavailable")}
        </p>
      )}
      {opened ? (
        <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">
          {t(opened.readonly ? "readonlyHint" : "legacyHint")}
        </p>
      ) : rows == null ? (
        <div role="status" className="p-4 text-sm text-muted-foreground">
          {t("loading")}
        </div>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          {rows.length ? t("select") : t("empty")}
        </p>
      )}
      <SideQuestionDock />
    </div>
  )
}

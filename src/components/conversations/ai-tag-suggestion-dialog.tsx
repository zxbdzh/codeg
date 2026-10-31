"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  applySuggestedTags,
  listConversationTags,
  suggestConversationTags,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { tagScopeFolderId } from "@/lib/conversation-tags"
import type {
  AiAssistantNewTagRequest,
  ConversationTagDetail,
} from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useConversationTagsStore } from "@/stores/conversation-tags-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export interface AiTagTarget {
  conversationId: number
  folderId: number
}

export function AiTagSuggestionDialog({
  conversationId,
  folderId,
  onClose,
}: AiTagTarget & { onClose: () => void }) {
  const t = useTranslations("AiTagging")
  const folder = useAppWorkspaceStore((s) =>
    s.allFolders.find((f) => f.id === folderId)
  )
  const scope = tagScopeFolderId(folder)
  const [existing, setExisting] = useState<
    Array<{ tag: ConversationTagDetail; reason: string; selected: boolean }>
  >([])
  const [proposed, setProposed] = useState<
    Array<AiAssistantNewTagRequest & { selected: boolean }>
  >([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let disposed = false
    setLoading(true)
    setError(null)
    Promise.all([
      suggestConversationTags(conversationId),
      listConversationTags(),
    ])
      .then(([suggestion, tags]) => {
        if (disposed) return
        const pool = tags.filter(
          (tag) =>
            tag.folder_id === null || (scope != null && tag.folder_id === scope)
        )
        const selected = suggestion.tags
          .flatMap((item) => {
            const tag = pool.find(
              (tag) => tag.name.toLowerCase() === item.name.toLowerCase()
            )
            return tag ? [{ tag, reason: item.reason, selected: true }] : []
          })
          .slice(0, 5)
        setExisting(selected)
        // 新建会改变用户的标签体系，因此必须额外勾选，不能随建议静默创建。
        setProposed(
          suggestion.new_tags.slice(0, 5 - selected.length).map((item) => ({
            name: item.name,
            color: /^#[0-9a-f]{6}$/i.test(item.color ?? "")
              ? item.color!
              : "#0969da",
            folderId: null,
            selected: false,
          }))
        )
      })
      .catch((err) => {
        if (!disposed) setError(toErrorMessage(err))
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [conversationId, scope, retry])
  const count =
    existing.filter((row) => row.selected).length +
    proposed.filter((row) => row.selected && row.name.trim()).length
  const apply = async () => {
    if (saving || !count) return
    setSaving(true)
    setError(null)
    try {
      const summary = await applySuggestedTags({
        conversationId,
        existingTagIds: existing
          .filter((row) => row.selected)
          .map((row) => row.tag.id),
        newTags: proposed
          .filter((row) => row.selected)
          .map(({ name, color, folderId }) => ({
            name: name.trim(),
            color,
            folderId,
          })),
      })
      useAppWorkspaceStore.getState().applyConversationUpsert(summary)
      void useConversationTagsStore.getState().fetchTags()
      onClose()
    } catch (err) {
      setError(toErrorMessage(err))
      setSaving(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {loading ? (
          <p role="status">{t("loading")}</p>
        ) : (
          <div className="grid gap-3">
            {existing.map((row, i) => (
              <label
                key={row.tag.id}
                className="flex items-start gap-3 rounded-md border p-3"
              >
                <input
                  type="checkbox"
                  aria-label={row.tag.name}
                  checked={row.selected}
                  disabled={saving}
                  onChange={(e) =>
                    setExisting((prev) =>
                      prev.map((r, j) =>
                        j === i ? { ...r, selected: e.target.checked } : r
                      )
                    )
                  }
                />
                <span>
                  <span
                    className="font-medium"
                    style={{ color: row.tag.color }}
                  >
                    {row.tag.name}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {row.reason}
                  </span>
                </span>
              </label>
            ))}
            {proposed.length > 0 && (
              <p className="text-sm font-medium">{t("newTags")}</p>
            )}
            {proposed.map((row, i) => (
              <div key={i} className="grid gap-2 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label={row.name}
                    checked={row.selected}
                    disabled={saving}
                    onChange={(e) =>
                      setProposed((prev) =>
                        prev.map((r, j) =>
                          j === i ? { ...r, selected: e.target.checked } : r
                        )
                      )
                    }
                  />
                  <Input
                    aria-label={t("name")}
                    value={row.name}
                    maxLength={40}
                    disabled={saving}
                    onChange={(e) =>
                      setProposed((prev) =>
                        prev.map((r, j) =>
                          j === i ? { ...r, name: e.target.value } : r
                        )
                      )
                    }
                  />
                  <input
                    type="color"
                    aria-label={t("color")}
                    value={row.color}
                    disabled={saving}
                    onChange={(e) =>
                      setProposed((prev) =>
                        prev.map((r, j) =>
                          j === i ? { ...r, color: e.target.value } : r
                        )
                      )
                    }
                  />
                </div>
                <select
                  aria-label={t("scope")}
                  className="rounded border bg-background p-1 text-sm"
                  value={row.folderId ?? "global"}
                  disabled={saving}
                  onChange={(e) =>
                    setProposed((prev) =>
                      prev.map((r, j) =>
                        j === i
                          ? {
                              ...r,
                              folderId:
                                e.target.value === "global"
                                  ? null
                                  : Number(e.target.value),
                            }
                          : r
                      )
                    )
                  }
                >
                  <option value="global">{t("global")}</option>
                  {scope != null && (
                    <option value={scope}>{t("folder")}</option>
                  )}
                </select>
              </div>
            ))}
            {!existing.length && !proposed.length && !error && (
              <p>{t("empty")}</p>
            )}
          </div>
        )}
        {error && (
          <div role="alert" className="text-sm text-destructive">
            {error}
            {!saving && (
              <Button variant="link" onClick={() => setRetry((n) => n + 1)}>
                {t("retry")}
              </Button>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            disabled={loading || saving || !count}
            onClick={() => void apply()}
          >
            {saving ? t("applying") : t("apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

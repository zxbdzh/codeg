"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  closeTagSuggestionBatch,
  confirmTagSuggestionBatch,
  generateTagSuggestionBatch,
  getTagSuggestionStatus,
  ignoreTagSuggestion,
  listConversationTags,
  openTagSuggestionBatch,
  restoreIgnoredTag,
  skipTagSuggestionBatch,
  type TagSuggestionChoice,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  AiTagBatch,
  AiTagIgnored,
  ConversationTagDetail,
} from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useConversationTagsStore } from "@/stores/conversation-tags-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { tagScopeFolderId } from "@/lib/conversation-tags"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { AiTagTarget } from "./ai-tag-suggestion-dialog"

function releaseReview(
  conversationId: number,
  batch: Pick<AiTagBatch, "id" | "leaseToken">
) {
  return batch.leaseToken
    ? closeTagSuggestionBatch(conversationId, batch.id, batch.leaseToken)
    : closeTagSuggestionBatch(conversationId, batch.id)
}

export function AiTagBatchDialog({
  conversationId,
  folderId,
  onClose,
}: AiTagTarget & { onClose: () => void }) {
  const t = useTranslations("AiTagging")
  const tAuto = useTranslations("AutoTagSuggestions")
  const [batch, setBatch] = useState<AiTagBatch | null>(null)
  const openedBatch = useRef<Pick<AiTagBatch, "id" | "leaseToken"> | null>(null)
  const [tags, setTags] = useState<ConversationTagDetail[]>([])
  const [choices, setChoices] = useState<TagSuggestionChoice[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hidden, setHidden] = useState<number[]>([])
  const [ignored, setIgnored] = useState<AiTagIgnored[]>([])
  const [scopeChoices, setScopeChoices] = useState<Record<number, number>>({})
  const folder = useAppWorkspaceStore((state) =>
    state.allFolders.find((item) => item.id === folderId)
  )
  const folderScope = tagScopeFolderId(folder)
  const [edits, setEdits] = useState<
    Record<number, { name: string; color: string; folderId: number | null }>
  >({})
  const editCandidate = (
    index: number,
    patch: Partial<{ name: string; color: string; folderId: number | null }>
  ) => {
    const candidate = batch?.candidates[index]
    if (!candidate) return
    const next = {
      ...(edits[index] ?? {
        name: candidate.name,
        color: candidate.color,
        folderId: candidate.folderId,
      }),
      ...patch,
    }
    setEdits((previous) => ({ ...previous, [index]: next }))
    const identity = candidate.index ?? index
    setChoices((previous) =>
      previous.map((choice) =>
        choice.index === identity ? { index: identity, ...next } : choice
      )
    )
  }
  useEffect(() => {
    let disposed = false
    void (async () => {
      const [stored, available] = await Promise.all([
        getTagSuggestionStatus(conversationId),
        listConversationTags(),
      ])
      const status =
        !stored.batch && !stored.ignored.length && !stored.error
          ? await generateTagSuggestionBatch(conversationId, false)
          : stored
      if (!disposed) {
        setIgnored(status.ignored)
        setError(status.error)
      }
      if (!status.batch) return
      const current = await openTagSuggestionBatch(
        conversationId,
        status.batch.id
      )
      if (disposed) {
        await releaseReview(conversationId, current)
        return
      }
      openedBatch.current = current
      setBatch(current)
      setTags(available)
      setChoices(
        current.candidates.flatMap((candidate, index) =>
          candidate.tagIds.length === 1
            ? [{ index: candidate.index ?? index, tagId: candidate.tagIds[0] }]
            : []
        )
      )
    })()
      .catch((failure: unknown) => {
        if (!disposed) setError(toErrorMessage(failure))
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
      const opened = openedBatch.current
      openedBatch.current = null
      if (opened) void releaseReview(conversationId, opened).catch(() => {})
    }
  }, [conversationId])
  useEffect(() => {
    const id = batch?.id
    const token = batch?.leaseToken
    if (!id || !token) return
    let disposed = false
    const timer = window.setInterval(() => {
      // 续期只延长持有权，不能覆盖当前勾选或采用后台返回的新候选。
      void openTagSuggestionBatch(conversationId, id, token).catch(
        (failure: unknown) => {
          if (!disposed) setError(toErrorMessage(failure))
        }
      )
    }, 60_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [batch?.id, batch?.leaseToken, conversationId])
  const apply = async () => {
    if (!batch || saving || !choices.length) return
    setSaving(true)
    try {
      const summary = await confirmTagSuggestionBatch({
        conversationId,
        batchId: batch.id,
        choices,
      })
      useAppWorkspaceStore.getState().applyConversationUpsert(summary)
      void useConversationTagsStore.getState().fetchTags()
      onClose()
    } catch (failure) {
      setError(toErrorMessage(failure))
      setSaving(false)
    }
  }
  const skip = async () => {
    if (!batch || saving) return
    setSaving(true)
    try {
      await skipTagSuggestionBatch(conversationId, batch.id)
      onClose()
    } catch (failure) {
      setError(toErrorMessage(failure))
      setSaving(false)
    }
  }
  const ignore = async (index: number) => {
    if (!batch || saving) return
    const candidate = batch.candidates[index]
    setSaving(true)
    try {
      await ignoreTagSuggestion(
        conversationId,
        batch.id,
        candidate.index ?? index,
        candidate.tagIds.length === 1
          ? candidate.tagIds[0]
          : scopeChoices[index]
      )
      setHidden((previous) => [...previous, index])
      setChoices((previous) =>
        previous.filter((choice) => choice.index !== (candidate.index ?? index))
      )
    } catch (failure) {
      setError(toErrorMessage(failure))
    } finally {
      setSaving(false)
    }
  }
  const restore = async (key: string) => {
    setSaving(true)
    try {
      await restoreIgnoredTag(conversationId, key)
      setIgnored((previous) => previous.filter((item) => item.key !== key))
    } catch (failure) {
      setError(toErrorMessage(failure))
    } finally {
      setSaving(false)
    }
  }
  const refresh = async () => {
    if (saving || loading) return
    setLoading(true)
    setError(null)
    try {
      const status = await generateTagSuggestionBatch(conversationId, true)
      const current = status.batch
        ? await openTagSuggestionBatch(conversationId, status.batch.id)
        : null
      openedBatch.current = current
      if (batch) await releaseReview(conversationId, batch)
      setBatch(current)
      setIgnored(status.ignored)
      setHidden([])
      setEdits({})
      setScopeChoices({})
      setChoices(
        current?.candidates.flatMap((candidate, index) =>
          candidate.tagIds.length === 1
            ? [{ index: candidate.index ?? index, tagId: candidate.tagIds[0] }]
            : []
        ) ?? []
      )
    } catch (failure) {
      setError(toErrorMessage(failure))
    } finally {
      setLoading(false)
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
          batch?.candidates.map((candidate, index) =>
            hidden.includes(index) ? null : (
              <div
                key={index}
                className="flex items-start gap-3 rounded-md border p-3"
              >
                <input
                  type="checkbox"
                  aria-label={candidate.name}
                  disabled={
                    saving ||
                    (candidate.tagIds.length > 1 && !scopeChoices[index])
                  }
                  checked={choices.some(
                    (choice) => choice.index === (candidate.index ?? index)
                  )}
                  onChange={(event) =>
                    setChoices((previous) =>
                      event.target.checked
                        ? [
                            ...previous,
                            candidate.tagIds.length
                              ? {
                                  index: candidate.index ?? index,
                                  tagId:
                                    scopeChoices[index] ?? candidate.tagIds[0],
                                }
                              : {
                                  index: candidate.index ?? index,
                                  ...(edits[index] ?? {
                                    name: candidate.name,
                                    color: candidate.color,
                                    folderId: candidate.folderId,
                                  }),
                                },
                          ]
                        : previous.filter(
                            (choice) =>
                              choice.index !== (candidate.index ?? index)
                          )
                    )
                  }
                />
                <span>
                  <span className="font-medium">{candidate.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {candidate.reason}
                  </span>
                  {!candidate.tagIds.length && (
                    <span className="grid gap-2">
                      <Input
                        aria-label={t("name")}
                        maxLength={64}
                        value={edits[index]?.name ?? candidate.name}
                        disabled={saving}
                        onChange={(event) =>
                          editCandidate(index, { name: event.target.value })
                        }
                      />
                      <input
                        type="color"
                        aria-label={t("color")}
                        value={edits[index]?.color ?? candidate.color}
                        disabled={saving}
                        onChange={(event) =>
                          editCandidate(index, { color: event.target.value })
                        }
                      />
                      <select
                        aria-label={t("scope")}
                        value={edits[index]?.folderId ?? "global"}
                        disabled={saving}
                        onChange={(event) =>
                          editCandidate(index, {
                            folderId:
                              event.target.value === "global"
                                ? null
                                : Number(event.target.value),
                          })
                        }
                      >
                        <option value="global">{tAuto("global")}</option>
                        {folderScope != null && (
                          <option value={folderScope}>{tAuto("folder")}</option>
                        )}
                      </select>
                    </span>
                  )}
                  {candidate.tagIds.length > 1 && (
                    <select
                      aria-label={tAuto("scopeName", { name: candidate.name })}
                      value={scopeChoices[index] ?? ""}
                      disabled={saving}
                      onChange={(event) => {
                        const tagId = Number(event.target.value)
                        setScopeChoices((previous) => ({
                          ...previous,
                          [index]: tagId,
                        }))
                        setChoices((previous) =>
                          previous.filter(
                            (choice) =>
                              choice.index !== (candidate.index ?? index)
                          )
                        )
                      }}
                    >
                      <option value="">{tAuto("chooseScope")}</option>
                      {candidate.tagIds.map((id) => {
                        const tag = tags.find((item) => item.id === id)
                        return (
                          <option key={id} value={id}>
                            {tag?.folder_id == null
                              ? tAuto("global")
                              : tAuto("folder")}{" "}
                            · {tag?.name ?? candidate.name}
                          </option>
                        )
                      })}
                    </select>
                  )}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={tAuto("ignoreName", { name: candidate.name })}
                  disabled={
                    saving ||
                    (candidate.tagIds.length > 1 && !scopeChoices[index])
                  }
                  onClick={() => void ignore(index)}
                >
                  {tAuto("ignore")}
                </Button>
              </div>
            )
          )
        )}
        {error && <p role="alert">{error}</p>}
        <Button
          variant="outline"
          disabled={loading || saving}
          onClick={() => void refresh()}
        >
          {t("refresh")}
        </Button>
        {ignored.length > 0 && (
          <section aria-label={tAuto("ignored")}>
            <p className="text-sm font-medium">{tAuto("ignored")}</p>
            {ignored.map((item) => (
              <div key={item.key} className="flex items-center justify-between">
                <span>{item.name}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={tAuto("restoreName", { name: item.name })}
                  disabled={saving}
                  onClick={() => void restore(item.key)}
                >
                  {tAuto("restore")}
                </Button>
              </div>
            ))}
          </section>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant="outline"
            disabled={loading || saving || !batch}
            onClick={() => void skip()}
          >
            {tAuto("skip")}
          </Button>
          <Button
            disabled={loading || saving || !choices.length}
            onClick={() => void apply()}
          >
            {t("apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

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
  Loader2,
  MessageCircleQuestionMark,
  Plus,
  SquareTerminal,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { NativeAttachedTerminal } from "@/components/conversations/native-session-views"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useOptionalConnectionStore } from "@/contexts/acp-connections-context"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useTabStore } from "@/contexts/tab-context"
import { toErrorMessage } from "@/lib/app-error"
import {
  closeNativeSideQuestion,
  createNativeSideQuestion,
  listNativeSideQuestions,
  openNativeSideQuestion,
  supportsNativeTerminal,
  type NativeSessionSource,
  type NativeSideQuestion,
} from "@/lib/native-session"
import { getTransport } from "@/lib/transport"
import { randomUUID } from "@/lib/utils"

/**
 * 原生旁问：每个旁问由后端维护独立分支与 PTY，前端只负责列表、切换与挂载。
 * 关闭只断开 PTY，历史项保留；重新打开会重新 attach 到该旁问自己的终端。
 */
export function SideQuestionTab() {
  const t = useTranslations("Folder.sideQuestion")
  const { isOpen, activeTab } = useAuxPanelContext()
  const active = isOpen && activeTab === "side_question"
  const tabs = useTabStore((state) => state.tabs)
  const activeTabId = useTabStore((state) => state.activeTabId)
  const sourceTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId]
  )

  const connectionStore = useOptionalConnectionStore()
  const subscribeConnection = useCallback(
    (listener: () => void) =>
      sourceTab && connectionStore
        ? connectionStore.subscribeKey(sourceTab.id, listener)
        : () => {},
    [connectionStore, sourceTab]
  )
  const getConnection = useCallback(
    () =>
      sourceTab ? connectionStore?.getConnection(sourceTab.id) : undefined,
    [connectionStore, sourceTab]
  )
  const connection = useSyncExternalStore(
    subscribeConnection,
    getConnection,
    () => undefined
  )

  const sourceConnectionId = connection?.connectionId ?? null
  const sourceTabId = sourceTab?.id ?? null
  const sourceTabAgentType = sourceTab?.agentType
  const sourceTabConversationId = sourceTab?.conversationId ?? null
  const source = useMemo<NativeSessionSource | null>(() => {
    if (!sourceTabId || !sourceTabAgentType) return null
    if (!supportsNativeTerminal(sourceTabAgentType)) return null
    if (!sourceConnectionId && sourceTabConversationId == null) return null
    return {
      sourceConnectionId: sourceConnectionId ?? "",
      sourceConversationId: sourceTabConversationId,
      sourceAgentType: sourceTabAgentType,
    }
  }, [
    sourceConnectionId,
    sourceTabAgentType,
    sourceTabConversationId,
    sourceTabId,
  ])
  const sourceKey = source
    ? `${source.sourceConnectionId}:${source.sourceConversationId ?? "draft"}:${source.sourceAgentType}`
    : null
  const unavailable = !sourceTab
    ? t("noActiveSession")
    : !supportsNativeTerminal(sourceTab.agentType)
      ? t("unsupported")
      : !connection?.connectionId
        ? t("connectionRequired")
        : null

  return (
    <SideQuestionSession
      key={sourceKey ?? "unavailable"}
      active={active}
      source={source}
      sourceKey={sourceKey}
      unavailable={unavailable}
      workingDir={sourceTab?.workingDir ?? ""}
    />
  )
}

function SideQuestionSession({
  active,
  source,
  sourceKey,
  unavailable,
  workingDir,
}: {
  active: boolean
  source: NativeSessionSource | null
  sourceKey: string | null
  unavailable: string | null
  workingDir: string
}) {
  const t = useTranslations("Folder.sideQuestion")

  const [items, setItems] = useState<NativeSideQuestion[]>([])
  const [terminalIds, setTerminalIds] = useState<Record<string, string>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [creating, setCreating] = useState(false)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const pendingCreation = useRef<{ requestId: string; title: string } | null>(
    null
  )

  // 面板打开或切回源会话时重新拉取：未关闭的旁问重新 attach 到原 PTY，
  // 已关闭的只作为历史列出。
  useEffect(() => {
    if (!active || !source || !sourceKey) return
    let cancelled = false
    const transport = getTransport()
    void (async () => {
      // 放在异步回调里重置，避免 effect 同步 setState 引发的级联渲染。
      setRestoring(true)
      setItems([])
      setTerminalIds({})
      setSelectedId(null)
      try {
        const list = await listNativeSideQuestions(transport, source)
        if (cancelled) return
        setItems(list)
        const opened = await Promise.all(
          list
            .filter((item) => item.isOpen)
            .map(async (item) => {
              try {
                const handle = await openNativeSideQuestion(transport, item.id)
                return [item.id, handle.terminalId] as const
              } catch (error) {
                console.error("[SideQuestionTab] restore terminal:", error)
                return null
              }
            })
        )
        if (cancelled) return
        const restored: Record<string, string> = {}
        for (const pair of opened) {
          if (pair) restored[pair[0]] = pair[1]
        }
        setTerminalIds(restored)
        setSelectedId(Object.keys(restored)[0] ?? null)
      } catch (error) {
        console.error("[SideQuestionTab] list side questions:", error)
        if (!cancelled)
          toast.error(t("listFailed"), { description: toErrorMessage(error) })
      } finally {
        if (!cancelled) setRestoring(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [active, source, sourceKey, t])

  const createSide = useCallback(async () => {
    if (!source?.sourceConnectionId || creating) return
    setCreating(true)
    const request = pendingCreation.current ?? {
      requestId: randomUUID(),
      title: `${t("title")} ${items.length + 1}`,
    }
    pendingCreation.current = request
    try {
      const { sideQuestion, terminalId } = await createNativeSideQuestion(
        getTransport(),
        source,
        request
      )
      pendingCreation.current = null
      setItems((prev) => [
        sideQuestion,
        ...prev.filter((item) => item.id !== sideQuestion.id),
      ])
      setTerminalIds((prev) => ({ ...prev, [sideQuestion.id]: terminalId }))
      setSelectedId(sideQuestion.id)
    } catch (error) {
      console.error("[SideQuestionTab] create side question:", error)
      toast.error(t("createFailed"), { description: toErrorMessage(error) })
    } finally {
      setCreating(false)
    }
  }, [creating, items.length, source, t])

  const selectSide = useCallback(
    async (item: NativeSideQuestion) => {
      if (terminalIds[item.id]) {
        setSelectedId(item.id)
        return
      }
      if (openingId) return
      setOpeningId(item.id)
      try {
        const { terminalId } = await openNativeSideQuestion(
          getTransport(),
          item.id
        )
        setTerminalIds((prev) => ({ ...prev, [item.id]: terminalId }))
        // 关闭过的历史再次打开后恢复为打开状态。
        setItems((prev) =>
          prev.map((entry) =>
            entry.id === item.id ? { ...entry, isOpen: true } : entry
          )
        )
        setSelectedId(item.id)
      } catch (error) {
        console.error("[SideQuestionTab] open side question:", error)
        toast.error(t("openFailed"), { description: toErrorMessage(error) })
      } finally {
        setOpeningId(null)
      }
    },
    [openingId, terminalIds, t]
  )

  const closeSide = useCallback(
    async (id: string) => {
      try {
        await closeNativeSideQuestion(getTransport(), id)
      } catch (error) {
        console.error("[SideQuestionTab] close side question:", error)
        toast.error(t("closeFailed"), { description: toErrorMessage(error) })
        return
      }
      setSelectedId((prev) => (prev === id ? null : prev))
      setTerminalIds((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      setItems((prev) =>
        prev.map((entry) =>
          entry.id === id ? { ...entry, isOpen: false } : entry
        )
      )
    },
    [t]
  )

  const selected = items.find((item) => item.id === selectedId) ?? null
  const selectedTerminalId = selected ? terminalIds[selected.id] : undefined
  const selectedWorkingDir = selected?.cwd ?? workingDir

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col text-[13px]"
      aria-label={t("title")}
    >
      <div className="shrink-0 border-b border-border">
        <div className="flex h-10 items-center justify-between gap-2 px-3">
          <span className="flex min-w-0 items-center gap-2 font-medium">
            <MessageCircleQuestionMark
              className="size-4 shrink-0 text-muted-foreground"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <span className="truncate">{t("title")}</span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 shrink-0 rounded-md text-muted-foreground"
            aria-label={t("newSideQuestion")}
            title={t("newSideQuestion")}
            disabled={!source?.sourceConnectionId || creating || restoring}
            onClick={() => void createSide()}
          >
            {creating ? (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            ) : (
              <Plus className="size-4" aria-hidden />
            )}
          </Button>
        </div>
        {unavailable && (
          <p
            role="status"
            className="px-3 pb-3 text-[11px] leading-relaxed text-foreground/70"
          >
            {unavailable}
          </p>
        )}
      </div>

      <div className="max-h-44 shrink-0 overflow-hidden border-b border-border">
        <ScrollArea className="h-full">
          <ul className="space-y-1 p-2" aria-label={t("title")}>
            {restoring && items.length === 0 ? (
              <li
                role="status"
                className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground"
              >
                <Loader2
                  className="size-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
                {t("loadingSides")}
              </li>
            ) : items.length === 0 ? (
              <li className="px-2 py-1.5 text-[11px] text-muted-foreground">
                {t("noSides")}
              </li>
            ) : (
              items.map((item) => (
                <li key={item.id}>
                  <div className="group flex min-w-0 items-center gap-1">
                    <button
                      type="button"
                      aria-label={item.title}
                      aria-pressed={selectedId === item.id}
                      title={item.title}
                      onClick={() => void selectSide(item)}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60 aria-pressed:bg-muted"
                    >
                      <SquareTerminal
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {item.title}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {item.isOpen ? t("opened") : t("closed")}
                      </span>
                      {openingId === item.id && (
                        <Loader2
                          className="size-3 shrink-0 animate-spin motion-reduce:animate-none"
                          aria-hidden
                        />
                      )}
                    </button>
                    {item.isOpen && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="size-6 shrink-0 rounded text-muted-foreground"
                        aria-label={t("close")}
                        title={t("close")}
                        disabled={restoring || openingId === item.id}
                        onClick={() => void closeSide(item.id)}
                      >
                        <X className="size-3.5" aria-hidden />
                      </Button>
                    )}
                  </div>
                </li>
              ))
            )}
          </ul>
        </ScrollArea>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {selected && selectedTerminalId ? (
          <NativeAttachedTerminal
            terminalId={selectedTerminalId}
            workingDir={selectedWorkingDir}
            isActive={active}
            isVisible={active}
            className="min-h-0 flex-1"
          />
        ) : (
          <div className="p-3 text-[11px] leading-relaxed text-muted-foreground">
            {unavailable ? null : t("nativeTerminalHint")}
          </div>
        )}
      </div>
    </section>
  )
}

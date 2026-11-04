"use client"

import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { formatDistanceToNow } from "date-fns"
import { enUS, zhCN, zhTW } from "date-fns/locale"
import { File, Folder } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useConversationTagsStore } from "@/stores/conversation-tags-store"
import { useTabActions } from "@/contexts/tab-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useWorkspaceActions } from "@/contexts/workspace-context"
import { listAllConversations } from "@/lib/api"
import type {
  AgentType,
  ConversationStatus,
  DbConversationSummary,
} from "@/lib/types"
import { useFileTree, type FlatFileEntry } from "@/hooks/use-file-tree"
import { rankFileMatches } from "@/lib/file-search-match"
import { rankConversationSearchMatches } from "@/lib/conversation-search"
import { resolveTags } from "@/lib/conversation-tags"
import { compareAgentType } from "@/lib/types"
import { getAgentLabel } from "@/lib/custom-agents"
import { AgentIcon } from "@/components/agent-icon"
import { ConversationStatusDot } from "@/components/conversations/conversation-status-dot"
import { ConversationTagChips } from "@/components/conversations/conversation-tag-chip"
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command"
import { cn } from "@/lib/utils"
import { formatConversationTitle } from "@/lib/conversation-title"

type SearchTab = "conversations" | "files"

interface SearchCommandDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SearchCommandDialog(props: SearchCommandDialogProps) {
  // Ctrl+K 从外部关闭面板时也卸载本轮输入，重开不会残留查询和筛选。
  return props.open ? <OpenSearchCommandDialog {...props} /> : null
}

function OpenSearchCommandDialog({
  open,
  onOpenChange,
}: SearchCommandDialogProps) {
  const t = useTranslations("Folder.search")
  const locale = useLocale()
  const dateFnsLocale =
    locale === "zh-CN" ? zhCN : locale === "zh-TW" ? zhTW : enUS
  const { activeFolder: folder, activeFolderId } = useActiveFolder()
  const allConversations = useAppWorkspaceStore((s) => s.conversations)
  const tags = useConversationTagsStore((s) => s.tags)
  const tagsById = useConversationTagsStore((s) => s.tagsById)
  const folderId = activeFolderId ?? 0
  const conversations = useMemo(
    () =>
      activeFolderId == null
        ? []
        : allConversations.filter((c) => c.folder_id === activeFolderId),
    [allConversations, activeFolderId]
  )
  const { openTab } = useTabActions()
  const { openConversations } = useWorkbenchRoute()
  const { openFilePreview } = useWorkspaceActions()
  const { revealInFileTree } = useAuxPanelContext()

  const [activeTab, setActiveTab] = useState<SearchTab>("conversations")
  // The search box owns the keyboard: the dialog opens with the cursor in it,
  // and switching tabs or agent filters leaves it there, so typing always
  // searches.
  const inputRef = useRef<HTMLInputElement>(null)
  const switchTab = useCallback((tab: SearchTab) => {
    setActiveTab(tab)
    inputRef.current?.focus()
  }, [])
  const [query, setQuery] = useState("")
  const [agentFilter, setAgentFilter] = useState<AgentType | null>(null)
  const [results, setResults] = useState<DbConversationSummary[]>([])
  const [searching, setSearching] = useState(false)

  const folderPath = folder?.path ?? ""

  // File search via shared hook (lazy-loaded when files tab is active)
  const {
    allFiles,
    loading: filesLoading,
    reset: resetFileTree,
  } = useFileTree({
    folderPath: folderPath || undefined,
    enabled: activeTab === "files",
  })

  // Compute which agent types exist in current folder
  const availableAgents = Array.from(
    new Set(conversations.map((c) => c.agent_type))
  ).sort(compareAgentType)

  // Rank files by relevance (name/path tiers + fuzzy subsequence), scanning the
  // full list so a deeply nested match isn't crowded out by shallower ones.
  const filteredFiles = useMemo(
    () => rankFileMatches(query, allFiles, 100),
    [allFiles, query]
  )

  const handleDialogOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setQuery("")
        setAgentFilter(null)
        setResults([])
        setSearching(false)
        setActiveTab("conversations")
        resetFileTree()
      }
      onOpenChange(nextOpen)
    },
    [onOpenChange, resetFileTree]
  )

  // 按本次打开的文件夹读取候选，标签匹配不能先被后端的标题条件排除。
  // 输入过程在本地完成，关闭或切换文件夹后的旧响应不能覆盖当前结果。
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void Promise.resolve().then(async () => {
      if (cancelled) return
      setSearching(true)
      try {
        const data = await listAllConversations({
          folder_ids: folderId > 0 ? [folderId] : null,
        })
        if (!cancelled) setResults(data)
      } catch {
        if (!cancelled) setResults([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [open, folderId])

  const searchResults = useMemo(() => {
    const scopedResults =
      folderId > 0
        ? results.filter((conversation) => conversation.folder_id === folderId)
        : results
    const candidates = agentFilter
      ? scopedResults.filter(
          (conversation) => conversation.agent_type === agentFilter
        )
      : scopedResults
    if (!query.trim()) return agentFilter ? candidates : []
    return rankConversationSearchMatches(query, candidates, tags)
  }, [results, query, agentFilter, tags, folderId])

  const handleSelectConversation = useCallback(
    (conv: DbConversationSummary) => {
      // Leave any workbench route (e.g. Automations) so the picked conversation
      // isn't stranded behind the route overlay — covers re-selecting the
      // already-active tab, which doesn't change activeTabId.
      openConversations()
      openTab(conv.folder_id, conv.id, conv.agent_type, true)
      handleDialogOpenChange(false)
    },
    [openTab, handleDialogOpenChange, openConversations]
  )

  const handleSelectFile = useCallback(
    (entry: FlatFileEntry) => {
      if (entry.kind === "dir") {
        revealInFileTree(entry.relativePath)
      } else {
        // Reveal parent directory in file tree, then open the file
        const lastSlash = entry.relativePath.lastIndexOf("/")
        if (lastSlash > 0) {
          revealInFileTree(entry.relativePath.slice(0, lastSlash))
        }
        openFilePreview(entry.relativePath)
      }
      handleDialogOpenChange(false)
    },
    [revealInFileTree, openFilePreview, handleDialogOpenChange]
  )

  const placeholder =
    activeTab === "conversations" ? t("placeholder") : t("filePlaceholder")

  return (
    <CommandDialog
      title={
        folder
          ? t("dialogTitleWithFolder", { name: folder.name })
          : t("dialogTitle")
      }
      open={open}
      onOpenChange={handleDialogOpenChange}
      // 结果已按标题和标签统一排序；cmdk 再按标题过滤会丢掉标签命中。
      shouldFilter={false}
      // Not `autoFocus`: an input focused while mounting takes focus before
      // the focus trap starts listening, so the trap never records it and has
      // nothing to pull focus back to when the chat composer behind the dialog
      // refocuses itself at the end of a turn — the rest of the query would be
      // typed into the composer.
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        inputRef.current?.focus()
      }}
    >
      {/* Folder context header */}
      {folder && (
        <div className="flex items-center gap-2 border-b px-4 py-2.5">
          <Folder className="w-4 h-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium truncate">
            {t("dialogTitleWithFolder", { name: folder.name })}
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-0 border-b px-3">
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => switchTab("conversations")}
          className={cn(
            "relative h-9 px-3 text-sm font-medium transition-colors",
            activeTab === "conversations"
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t("tabConversations")}
          {activeTab === "conversations" && (
            <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-foreground rounded-full" />
          )}
        </button>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => switchTab("files")}
          className={cn(
            "relative h-9 px-3 text-sm font-medium transition-colors",
            activeTab === "files"
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t("tabFiles")}
          {activeTab === "files" && (
            <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-foreground rounded-full" />
          )}
        </button>
      </div>

      <CommandInput
        ref={inputRef}
        placeholder={placeholder}
        value={query}
        onValueChange={setQuery}
      />

      {/* Agent filter (conversations tab only). Wraps: one chip per agent type
          present in the folder, each carrying a full name, so a workspace with
          a dozen enabled agents runs past the dialog — which is
          `overflow-hidden`, so the tail chips were clipped away and simply
          could not be clicked. Wrapping keeps every filter reachable and lets
          the block grow by a row instead of hiding options. */}
      {activeTab === "conversations" && availableAgents.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 px-3 py-2 border-b">
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setAgentFilter(null)}
            className={cn(
              "h-6 shrink-0 text-xs px-2 rounded-md transition-colors",
              agentFilter === null
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t("allAgents")}
          </button>
          {availableAgents.map((at) => (
            <button
              key={at}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setAgentFilter(at)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 h-6 text-xs px-2 rounded-md transition-colors",
                agentFilter === at
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <AgentIcon agentType={at} className="w-3.5 h-3.5" />
              {getAgentLabel(at)}
            </button>
          ))}
        </div>
      )}

      <CommandList className="min-h-96">
        {/* Conversations tab */}
        {activeTab === "conversations" && (
          <>
            <CommandEmpty>
              {searching
                ? t("searching")
                : !query.trim() && !agentFilter
                  ? t("typeToSearch")
                  : t("noResults")}
            </CommandEmpty>
            {searchResults.length > 0 && (
              <CommandGroup>
                {searchResults.map((conv) => (
                  <CommandItem
                    key={conv.id}
                    value={`${conv.id}-${formatConversationTitle(conv.title)}`}
                    onSelect={() => handleSelectConversation(conv)}
                  >
                    <ConversationStatusDot
                      status={conv.status as ConversationStatus}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="truncate">
                        {formatConversationTitle(conv.title) ||
                          t("untitledConversation")}
                      </span>
                      <ConversationTagChips
                        tags={resolveTags(conv.tag_ids, tagsById)}
                        max={3}
                      />
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {getAgentLabel(conv.agent_type)}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatDistanceToNow(new Date(conv.created_at), {
                        addSuffix: true,
                        locale: dateFnsLocale,
                      })}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </>
        )}

        {/* Files tab */}
        {activeTab === "files" && (
          <>
            <CommandEmpty>
              {filesLoading
                ? t("searching")
                : !query.trim()
                  ? t("typeToSearchFiles")
                  : t("noResults")}
            </CommandEmpty>
            {filteredFiles.length > 0 && (
              <CommandGroup>
                {filteredFiles.map((entry) => (
                  <CommandItem
                    key={entry.relativePath}
                    value={entry.relativePath}
                    onSelect={() => handleSelectFile(entry)}
                  >
                    {entry.kind === "dir" ? (
                      <Folder className="w-4 h-4 shrink-0 text-blue-500" />
                    ) : (
                      <File className="w-4 h-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="flex-1 truncate">{entry.name}</span>
                    <span className="text-xs text-muted-foreground shrink-0 truncate max-w-48">
                      {entry.relativePath}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </>
        )}
      </CommandList>
    </CommandDialog>
  )
}

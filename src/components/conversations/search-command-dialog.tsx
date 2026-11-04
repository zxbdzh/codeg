"use client"

import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { formatDistanceToNow } from "date-fns"
import { enUS, zhCN, zhTW } from "date-fns/locale"
import { File, Folder } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useActiveFolder } from "@/contexts/active-folder-context"
import type { SearchTab } from "@/contexts/search-dialog-context"
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

interface SearchCommandDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * 挂载时选中的标签页。双击 Shift 打开的全局搜索传 `all`，把会话和文件放在
   * 同一个列表里；普通搜索仍从「会话」开始。
   */
  initialTab?: SearchTab
}

export function SearchCommandDialog(props: SearchCommandDialogProps) {
  // Ctrl+K 从外部关闭面板时也卸载本轮输入，重开不会残留查询和筛选。
  return props.open ? <OpenSearchCommandDialog {...props} /> : null
}

function OpenSearchCommandDialog({
  open,
  onOpenChange,
  initialTab = "conversations",
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

  const [activeTab, setActiveTab] = useState<SearchTab>(initialTab)
  const [query, setQuery] = useState("")
  const [agentFilter, setAgentFilter] = useState<AgentType | null>(null)
  const [results, setResults] = useState<DbConversationSummary[]>([])
  const [searching, setSearching] = useState(false)

  // The search box owns the keyboard: the dialog opens with the cursor in it,
  // and switching tabs or agent filters leaves it there, so typing always
  // searches.
  const inputRef = useRef<HTMLInputElement>(null)
  const switchTab = useCallback((tab: SearchTab) => {
    setActiveTab(tab)
    // 智能体筛选条只在「会话」页显示；带着上一页的筛选进「全部」会悄悄漏掉
    // 其它智能体的会话，所以进「全部」时清空筛选。
    if (tab === "all") setAgentFilter(null)
    inputRef.current?.focus()
  }, [])

  const folderPath = folder?.path ?? ""

  // File search via shared hook (lazy-loaded when a tab that shows files is
  // active: the Files tab and the unified All tab).
  const {
    allFiles,
    loading: filesLoading,
    loaded: filesLoaded,
    reset: resetFileTree,
  } = useFileTree({
    folderPath: folderPath || undefined,
    enabled: activeTab !== "conversations",
  })

  // Compute which agent types exist in current folder
  const availableAgents = Array.from(
    new Set(conversations.map((c) => c.agent_type))
  ).sort(compareAgentType)

  // Rank files by relevance (name/path tiers + fuzzy subsequence), scanning the
  // full list so a deeply nested match isn't crowded out by shallower ones.
  const filteredFiles = useMemo(
    // 切换项目后 hook 会暂存上一项目清单，未完成当前路径加载前不能展示。
    () =>
      folderPath && filesLoaded ? rankFileMatches(query, allFiles, 100) : [],
    [allFiles, query, folderPath, filesLoaded]
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
    // 未选项目时不回退成跨项目搜索，避免默认范围悄悄扩大。
    if (!open || folderId <= 0) return
    let cancelled = false
    void Promise.resolve().then(async () => {
      if (cancelled) return
      setSearching(true)
      try {
        const data = await listAllConversations({
          folder_ids: [folderId],
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
        : []
    const candidates = agentFilter
      ? scopedResults.filter(
          (conversation) => conversation.agent_type === agentFilter
        )
      : scopedResults
    if (!query.trim()) return agentFilter ? candidates : []
    return rankConversationSearchMatches(query, candidates, tags)
  }, [results, query, agentFilter, tags, folderId])

  // 「全部」页把会话和文件放进同一个列表：会话在前（用户通常先找会话），文件
  // 在后。数量设上限，避免大项目里一次渲染上千个条目。
  const allConversationResults = useMemo(() => {
    if (activeTab !== "all" || !query.trim()) return []
    return searchResults.slice(0, 20)
  }, [activeTab, query, searchResults])

  const allFileResults = useMemo(() => {
    if (activeTab !== "all" || !query.trim()) return []
    return filteredFiles.slice(0, 50)
  }, [activeTab, query, filteredFiles])

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

  const renderConversationItem = (conv: DbConversationSummary) => (
    <CommandItem
      key={conv.id}
      value={`${conv.id}-${formatConversationTitle(conv.title)}`}
      onSelect={() => handleSelectConversation(conv)}
    >
      <ConversationStatusDot status={conv.status as ConversationStatus} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate">
          {formatConversationTitle(conv.title) || t("untitledConversation")}
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
  )

  const renderFileItem = (entry: FlatFileEntry) => (
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
  )

  const placeholder =
    activeTab === "all"
      ? t("allPlaceholder")
      : activeTab === "conversations"
        ? t("placeholder")
        : t("filePlaceholder")

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
        {(
          [
            ["all", t("tabAll")],
            ["conversations", t("tabConversations")],
            ["files", t("tabFiles")],
          ] as const
        ).map(([tab, label]) => (
          <button
            key={tab}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => switchTab(tab)}
            className={cn(
              "relative h-9 px-3 text-sm font-medium transition-colors",
              activeTab === tab
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
            {activeTab === tab && (
              <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-foreground rounded-full" />
            )}
          </button>
        ))}
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
        {/* All tab (double-Shift global search): sessions first, then files,
            both already limited to the active folder. */}
        {activeTab === "all" && (
          <>
            <CommandEmpty>
              {searching || filesLoading
                ? t("searching")
                : !query.trim()
                  ? t("typeToSearchAll")
                  : t("noResults")}
            </CommandEmpty>
            {allConversationResults.length > 0 && (
              <CommandGroup heading={t("tabConversations")}>
                {allConversationResults.map(renderConversationItem)}
              </CommandGroup>
            )}
            {allFileResults.length > 0 && (
              <CommandGroup heading={t("tabFiles")}>
                {allFileResults.map(renderFileItem)}
              </CommandGroup>
            )}
          </>
        )}

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
                {searchResults.map(renderConversationItem)}
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
              <CommandGroup>{filteredFiles.map(renderFileItem)}</CommandGroup>
            )}
          </>
        )}
      </CommandList>
    </CommandDialog>
  )
}

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
import { folderScope, useFolderTabsStore } from "@/stores/folder-tabs-store"
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

type SearchScope = "current" | "projects"

interface ProjectFileEntry extends FlatFileEntry {
  folderId: number
  folderName: string
}

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
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const tags = useConversationTagsStore((s) => s.tags)
  const tagsById = useConversationTagsStore((s) => s.tagsById)
  const folderId = activeFolderId ?? 0
  // 范围独立于结果分类；每次重开仍从当前项目开始，扩大范围必须显式选择。
  const [scope, setScope] = useState<SearchScope>("current")
  const searchAllProjects = scope === "projects"
  const projectFolders = useMemo(
    () => allFolders.filter((item) => item.kind === "regular"),
    [allFolders]
  )
  const foldersById = useMemo(
    () => new Map(allFolders.map((item) => [item.id, item])),
    [allFolders]
  )
  const searchFolderIds = useMemo(
    () =>
      searchAllProjects
        ? projectFolders.map((item) => item.id)
        : folderId > 0
          ? [folderId]
          : [],
    [searchAllProjects, projectFolders, folderId]
  )
  const searchFolderIdSet = useMemo(
    () => new Set(searchFolderIds),
    [searchFolderIds]
  )
  const conversations = useMemo(
    () =>
      allConversations.filter((item) => searchFolderIdSet.has(item.folder_id)),
    [allConversations, searchFolderIdSet]
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
  const searchFolders = useMemo(
    () => (searchAllProjects ? projectFolders : folder ? [folder] : []),
    [searchAllProjects, projectFolders, folder]
  )
  const switchScope = (nextScope: SearchScope) => {
    setScope(nextScope)
    // 范围扩大后不能沿用另一个项目不可见的智能体筛选。
    setAgentFilter(null)
    inputRef.current?.focus()
  }

  // File search via shared hook (lazy-loaded when a tab that shows files is
  // active: the Files tab and the unified All tab).
  const {
    allFiles,
    loading: filesLoading,
    loaded: filesLoaded,
    failedFolderCount,
    reset: resetFileTree,
  } = useFileTree({
    folderPaths: searchFolders.map((item) => item.path),
    enabled: activeTab !== "conversations",
    query,
  })

  useEffect(() => {
    // 面板关闭后卸载；每次重开都要求新鲜索引，同时允许本轮输入复用同一快照。
    resetFileTree(true)
  }, [resetFileTree])

  // Compute which agent types exist in the selected project scope
  const availableAgents = Array.from(
    new Set(conversations.map((c) => c.agent_type))
  ).sort(compareAgentType)

  // 项目归属随清单计算一次，输入关键词时不反复复制所有项目的文件元数据。
  const projectFiles = useMemo(() => {
    if (!filesLoaded) return []
    const foldersByPath = new Map(
      searchFolders.map((item) => [item.path, item])
    )
    const entries: ProjectFileEntry[] = []
    for (const entry of allFiles) {
      const owner = foldersByPath.get(entry.folderPath ?? folderPath)
      // 跨项目只列可直接打开的文件；目录定位仍属于当前项目的文件树。
      if (owner && (!searchAllProjects || entry.kind === "file")) {
        entries.push({
          ...entry,
          folderId: owner.id,
          folderName: owner.alias || owner.name,
        })
      }
    }
    return entries
  }, [allFiles, searchFolders, searchAllProjects, folderPath, filesLoaded])
  // 后端已按整工作区排序并限制返回量，深层命中不会因前端只保留部分索引而丢失。
  const filteredFiles = useMemo(
    () => rankFileMatches(query, projectFiles, 100),
    [query, projectFiles]
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

  // 按显式选择的项目范围读取候选，标签匹配不能先被后端标题条件排除。
  // 输入过程在本地完成，关闭或切换范围后的旧响应不能覆盖当前结果。
  useEffect(() => {
    // 未选项目时不回退成跨项目搜索，避免默认范围悄悄扩大。
    if (!open || searchFolderIds.length === 0) return
    let cancelled = false
    void Promise.resolve().then(async () => {
      if (cancelled) return
      setSearching(true)
      try {
        const data = await listAllConversations({
          folder_ids: searchFolderIds,
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
  }, [open, searchFolderIds])

  const searchResults = useMemo(() => {
    const scopedResults = results.filter((conversation) =>
      searchFolderIdSet.has(conversation.folder_id)
    )
    const candidates = agentFilter
      ? scopedResults.filter(
          (conversation) => conversation.agent_type === agentFilter
        )
      : scopedResults
    if (!query.trim()) return agentFilter ? candidates : []
    return rankConversationSearchMatches(query, candidates, tags)
  }, [results, query, agentFilter, tags, searchFolderIdSet])

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
    (entry: ProjectFileEntry) => {
      const isCurrentFolder = entry.folderId === folderId
      // 按项目隔离标签页时先激活目标范围，否则跨项目文件只会在后台打开。
      useFolderTabsStore.getState().activateScope(folderScope(entry.folderId))
      if (entry.kind === "dir") {
        revealInFileTree(entry.relativePath)
      } else {
        const lastSlash = entry.relativePath.lastIndexOf("/")
        if (isCurrentFolder && lastSlash > 0) {
          revealInFileTree(entry.relativePath.slice(0, lastSlash))
        }
        void openFilePreview(entry.relativePath, { folderId: entry.folderId })
      }
      handleDialogOpenChange(false)
    },
    [folderId, revealInFileTree, openFilePreview, handleDialogOpenChange]
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
        {searchAllProjects && (
          <span className="truncate text-xs text-muted-foreground">
            {foldersById.get(conv.folder_id)?.alias ||
              foldersById.get(conv.folder_id)?.name}
          </span>
        )}
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

  const renderFileItem = (entry: ProjectFileEntry) => (
    <CommandItem
      key={`${entry.folderId}:${entry.relativePath}`}
      value={`file:${entry.folderId}:${entry.relativePath}`}
      onSelect={() => handleSelectFile(entry)}
    >
      {entry.kind === "dir" ? (
        <Folder className="w-4 h-4 shrink-0 text-blue-500" />
      ) : (
        <File className="w-4 h-4 shrink-0 text-muted-foreground" />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate">{entry.name}</span>
        {searchAllProjects && (
          <span className="truncate text-xs text-muted-foreground">
            {entry.folderName}
          </span>
        )}
      </span>
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
        searchAllProjects
          ? t("dialogTitleWithFolder", { name: t("scopeAllProjects") })
          : folder
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
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5 pr-10">
        <Folder className="w-4 h-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {searchAllProjects
            ? t("scopeAllProjects")
            : folder?.alias || folder?.name || t("scopeCurrentProject")}
        </span>
        <div
          role="group"
          aria-label={t("scopeLabel")}
          className="flex shrink-0 gap-1"
        >
          {(
            [
              ["current", t("scopeCurrentProject")],
              ["projects", t("scopeAllProjects")],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              aria-pressed={scope === value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => switchScope(value)}
              className={cn(
                "h-7 rounded-md px-2 text-xs transition-colors",
                scope === value
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

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

      {activeTab !== "conversations" && failedFolderCount > 0 && (
        <div role="status" className="px-4 py-2 text-xs text-destructive">
          {t("fileLoadFailed", { count: failedFolderCount })}
        </div>
      )}

      <CommandList className="min-h-96">
        {/* All tab (double-Shift global search): sessions first, then files,
            both limited to the explicitly selected project scope. */}
        {activeTab === "all" && (
          <>
            <CommandEmpty>
              {searching || filesLoading
                ? t("searching")
                : !query.trim()
                  ? t(
                      searchAllProjects
                        ? "typeToSearchAllProjects"
                        : "typeToSearchAll"
                    )
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

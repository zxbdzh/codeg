"use client"

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react"

/**
 * 搜索面板的三个结果范围。`all` 是双击 Shift 打开的全局搜索（会话 + 文件
 * 混排），另外两个是普通搜索里的分类标签页。
 */
export type SearchTab = "all" | "conversations" | "files"

interface SearchDialogContextValue {
  open: boolean
  setOpen: Dispatch<SetStateAction<boolean>>
  /** 下一次挂载时选中的标签页；打开后由面板自己持有。 */
  initialTab: SearchTab
  setInitialTab: (tab: SearchTab) => void
  /** 打开面板并指定默认标签页（不传则回到「会话」）。 */
  openSearch: (tab?: SearchTab) => void
}

const SearchDialogContext = createContext<SearchDialogContextValue | null>(null)

/**
 * Shared open-state for the conversation search command dialog.
 *
 * The dialog itself, and the global ⌘K shortcut that toggles it, are owned by
 * `WorkspaceChromeController` (which is always mounted, desktop + mobile). The
 * trigger buttons live elsewhere: `LeftEdgeChrome` on desktop, `FolderTitleBar`
 * on mobile. Lifting just the boolean here lets any of them open the dialog
 * without owning it — including surfaces that unmount, which is why the trigger
 * was moved out of the sidebar in the first place.
 *
 * `setOpen` is the raw state setter so callers can use the functional updater
 * form (the shortcut handler does `setOpen((prev) => !prev)`).
 */
export function useSearchDialog() {
  const ctx = useContext(SearchDialogContext)
  if (!ctx) {
    throw new Error("useSearchDialog must be used within SearchDialogProvider")
  }
  return ctx
}

export function SearchDialogProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  // 打开意图与开合状态分开：面板只在挂载时读一次初始标签页，之后由它自己切页。
  const [initialTab, setInitialTab] = useState<SearchTab>("conversations")
  const openSearch = useCallback((tab: SearchTab = "conversations") => {
    setInitialTab(tab)
    setOpen(true)
  }, [])
  const value = useMemo<SearchDialogContextValue>(
    () => ({ open, setOpen, initialTab, setInitialTab, openSearch }),
    [open, initialTab, openSearch]
  )

  return (
    <SearchDialogContext.Provider value={value}>
      {children}
    </SearchDialogContext.Provider>
  )
}

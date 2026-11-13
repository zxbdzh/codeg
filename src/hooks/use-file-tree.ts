"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { searchWorkspaceFiles } from "@/lib/api"
import type { WorkspaceFileEntry } from "@/lib/types"
import { randomUUID } from "@/lib/utils"

export interface FlatFileEntry {
  name: string
  /** Relative path from folder root (same as WorkspaceFileEntry.path) */
  relativePath: string
  kind: "file" | "dir"
  /** 跨项目同名文件必须保留根路径，不能按当前项目解释相对路径。 */
  folderPath?: string
  /** Pre-computed lowercase relativePath for filtering */
  lowerPath: string
  /** Pre-computed lowercase name for filtering */
  lowerName: string
}

const EMPTY_FILES: FlatFileEntry[] = []

interface UseFileTreeOptions {
  folderPath?: string
  folderPaths?: readonly string[]
  enabled: boolean
  query?: string
  limit?: number
  filesOnly?: boolean
}

interface UseFileTreeResult {
  allFiles: FlatFileEntry[]
  loading: boolean
  loaded: boolean
  /** 失败的项目数；仅影响提示，不阻止复用其它项目的成功结果。 */
  failedFolderCount: number
  /** Discard local results; an explicit refresh also invalidates native data. */
  reset: (refreshIndex?: boolean) => void
}

/**
 * Keep only the current query's bounded matches in the renderer. Discovery,
 * indexing and ranking are shared in the backend, with a native cache budget.
 *
 * 单项目调用传 folderPath；全局搜索传 folderPaths，并按有限并发逐个项目查询，
 * 避免一次性把多个工作区的完整清单拉进前端。
 */
export function useFileTree({
  folderPath,
  folderPaths,
  enabled,
  query = "",
  limit = 100,
  filesOnly = false,
}: UseFileTreeOptions): UseFileTreeResult {
  // 用路径值标识请求：调用方重建数组不重扫磁盘，切换范围也不会露出旧项目结果。
  const pathsKey = JSON.stringify(
    [...new Set(folderPaths ?? (folderPath ? [folderPath] : []))].filter(
      Boolean
    )
  )
  const [allFiles, setAllFiles] = useState<FlatFileEntry[]>(EMPTY_FILES)
  const [loading, setLoading] = useState(false)
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const [failedFolderCount, setFailedFolderCount] = useState(0)
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  const refresh = useRef(false)
  // Set when a refresh was requested and the picker is next enabled: every
  // query until the next reset then needs a native snapshot built since that
  // moment. A window (not a per-request flag) lets later keystrokes reuse the
  // snapshot the first one built, even if that first response was aborted.
  const freshSince = useRef<number | null>(null)
  const consumer = useRef<string | undefined>(undefined)
  const scopeRef = useRef<string | null>(null)
  const cacheRef = useRef<{ key: string; files: FlatFileEntry[] } | null>(null)

  const requestKey = `${pathsKey}\0${query}\0${limit}\0${filesOnly}`

  useEffect(() => {
    const current = ++generation.current
    const paths: string[] = JSON.parse(pathsKey)
    const scope = `${pathsKey}\0${filesOnly}`
    if (scopeRef.current !== scope) {
      scopeRef.current = scope
      cacheRef.current = null
      setAllFiles(EMPTY_FILES)
      setLoadedKey(null)
      setFailedFolderCount(0)
    }
    if (!enabled || paths.length === 0) {
      setLoading(false)
      return
    }
    // 搜索面板在空查询时只显示引导文案；不为此扫描所有项目，避免输入前后
    // 的空查询请求和真实查询互相覆盖。
    if (!query.trim()) {
      cacheRef.current = { key: requestKey, files: EMPTY_FILES }
      setAllFiles(EMPTY_FILES)
      setLoadedKey(requestKey)
      setFailedFolderCount(0)
      setLoading(false)
      return
    }
    // 切换分类再回来时复用同一查询的结果，不重复扫描已打开的项目。
    if (cacheRef.current?.key === requestKey && !refresh.current) {
      setLoading(false)
      return
    }

    let canceled = false
    const abort = new AbortController()
    setLoading(true)
    if (refresh.current) {
      refresh.current = false
      freshSince.current = performance.now()
    }
    const since = freshSince.current

    async function load() {
      const batches: FlatFileEntry[][] = new Array(paths.length)
      let nextIndex = 0
      let failures = 0
      const loadNext = async () => {
        while (
          !canceled &&
          generation.current === current &&
          nextIndex < paths.length
        ) {
          const index = nextIndex++
          const root = paths[index]
          try {
            const files: WorkspaceFileEntry[] = await searchWorkspaceFiles(
              root,
              query,
              {
                limit,
                filesOnly,
                refresh: false,
                ...(since === null
                  ? {}
                  : {
                      maxAgeMs: Math.max(
                        0,
                        Math.floor(performance.now() - since)
                      ),
                    }),
                request: {
                  consumerId: (consumer.current ??= randomUUID()),
                  generation: current,
                },
                signal: abort.signal,
              }
            )
            batches[index] = files.map((file) => ({
              name: file.name,
              relativePath: file.path,
              kind: file.kind,
              folderPath: root,
              lowerPath: file.path.toLowerCase(),
              lowerName: file.name.toLowerCase(),
            }))
          } catch {
            // 主动取消不算项目失败，也不应覆盖当前查询的结果。
            if (abort.signal.aborted) return
            failures++
            batches[index] = []
          }
        }
      }
      // 全项目检索限制同时查询的目录数，避免大量项目压满磁盘或远端连接。
      await Promise.all(
        Array.from({ length: Math.min(paths.length, 4) }, loadNext)
      )
      if (canceled || generation.current !== current) return
      const flat = batches.flat()
      cacheRef.current = { key: requestKey, files: flat }
      setAllFiles(flat)
      setLoadedKey(requestKey)
      setFailedFolderCount(failures)
    }

    const timer = setTimeout(
      () => {
        void load().finally(() => {
          if (!canceled && generation.current === current) setLoading(false)
        })
      },
      query.trim() ? 150 : 0
    )
    return () => {
      canceled = true
      abort.abort()
      clearTimeout(timer)
    }
  }, [enabled, pathsKey, query, limit, filesOnly, revision, requestKey])

  const reset = useCallback((refreshIndex = false) => {
    // 立即使在途请求失效，不等下一轮 effect 清理再阻止旧结果回填。
    generation.current += 1
    cacheRef.current = null
    setAllFiles(EMPTY_FILES)
    setLoadedKey(null)
    setFailedFolderCount(0)
    setLoading(false)
    if (refreshIndex) {
      refresh.current = true
      freshSince.current = null
    }
    setRevision((value) => value + 1)
  }, [])

  return {
    allFiles,
    loading: enabled && loading,
    loaded: enabled && loadedKey === requestKey,
    failedFolderCount,
    reset,
  }
}

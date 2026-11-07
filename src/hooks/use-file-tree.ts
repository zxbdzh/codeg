"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { listWorkspaceFiles } from "@/lib/api"

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
}

interface FileTreeSnapshot {
  key: string
  files: FlatFileEntry[]
  loading: boolean
  failedFolderCount: number
}

/**
 * Lazily loads gitignore-aware file/dir listings for in-memory file search.
 * Single-project callers pass folderPath; the global search passes folderPaths.
 * Discovery and ignored-directory pruning stay in list_workspace_files.
 */
export function useFileTree({
  folderPath,
  folderPaths,
  enabled,
}: UseFileTreeOptions) {
  // 用路径值标识请求：调用方重建数组不重扫磁盘，切换范围也不会露出旧项目结果。
  const pathsKey = JSON.stringify(
    [...new Set(folderPaths ?? (folderPath ? [folderPath] : []))].filter(
      Boolean
    )
  )
  const [snapshot, setSnapshot] = useState<FileTreeSnapshot | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const loadedKeyRef = useRef<string | null>(null)
  const requestVersionRef = useRef(0)

  useEffect(() => {
    if (!enabled || loadedKeyRef.current === pathsKey) return
    const paths: string[] = JSON.parse(pathsKey)
    if (paths.length === 0) return
    let canceled = false
    const version = ++requestVersionRef.current

    void Promise.resolve().then(async () => {
      if (canceled || version !== requestVersionRef.current) return
      loadedKeyRef.current = null
      setSnapshot({
        key: pathsKey,
        files: [],
        loading: true,
        failedFolderCount: 0,
      })
      const batches: FlatFileEntry[][] = new Array(paths.length)
      let nextIndex = 0
      let failedFolderCount = 0
      const loadNext = async () => {
        while (
          !canceled &&
          version === requestVersionRef.current &&
          nextIndex < paths.length
        ) {
          const index = nextIndex++
          const root = paths[index]
          try {
            const files = await listWorkspaceFiles(root)
            batches[index] = files.map((file) => ({
              name: file.name,
              relativePath: file.path,
              kind: file.kind,
              folderPath: root,
              lowerPath: file.path.toLowerCase(),
              lowerName: file.name.toLowerCase(),
            }))
          } catch {
            failedFolderCount++
            batches[index] = []
          }
        }
      }
      // 全项目检索限制同时扫描的目录数，避免大量项目压满磁盘或远端连接。
      await Promise.all(
        Array.from({ length: Math.min(paths.length, 4) }, loadNext)
      )
      if (!canceled && version === requestVersionRef.current) {
        // 切换结果分类复用成功清单；失败项目在重新启用时仍可重试。
        if (failedFolderCount === 0) loadedKeyRef.current = pathsKey
        setSnapshot({
          key: pathsKey,
          files: batches.flat(),
          loading: false,
          failedFolderCount,
        })
      }
    })
    return () => {
      canceled = true
    }
  }, [enabled, pathsKey, reloadKey])

  const reset = useCallback(() => {
    // 立即使在途扫描失效，不等下一轮 effect 清理再阻止旧结果回填。
    requestVersionRef.current++
    loadedKeyRef.current = null
    setSnapshot(null)
    setReloadKey((value) => value + 1)
  }, [])

  const current = snapshot?.key === pathsKey ? snapshot : null
  const hasPaths = pathsKey !== "[]"
  return {
    allFiles: current?.files ?? EMPTY_FILES,
    loading: enabled && hasPaths && (!current || current.loading),
    loaded: current !== null && !current.loading,
    failedFolderCount: current?.failedFolderCount ?? 0,
    reset,
  }
}

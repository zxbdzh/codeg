"use client"

import { useCallback, useMemo, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { ConversationDetailHeader } from "./conversation-detail-header"
import { TerminalView } from "@/components/terminal/terminal-view"
import {
  useAcpActions,
  useOptionalConnectionStore,
} from "@/contexts/acp-connections-context"
import { toErrorMessage } from "@/lib/app-error"
import {
  closeNativeMainSession,
  openNativeMainSession,
  type NativeMainTerminal,
  type NativeSessionSource,
} from "@/lib/native-session"
import { getTransport } from "@/lib/transport"
import type { AgentType, ConversationStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

interface NativeSessionHeaderProps {
  tabId: string
  conversationId: number | null
  runtimeConversationId: number | null
  folderId: number
  folderPath: string | undefined
  /** 与 ACP 自动连接一致的 cwd；被动 attach 恢复连接时要用同一个值。 */
  workingDir?: string
  title: string
  status: ConversationStatus | undefined
  agentType: AgentType
  nativeTerminal: NativeMainTerminal | null
  /** 关闭终端时第二个参数是后端恢复出的 ACP 连接 id，供面板重读历史。 */
  onNativeTerminalChange: (
    terminal: NativeMainTerminal | null,
    restoredConnectionId?: string
  ) => void
}

/**
 * 会话标题栏 + 原生终端开关。连接状态只在订阅所在的 tab 上读取，
 * 避免把 ACP 连接 store 提升到整个会话面板。
 */
export function NativeSessionHeader({
  tabId,
  conversationId,
  runtimeConversationId,
  folderId,
  folderPath,
  workingDir,
  title,
  status,
  agentType,
  nativeTerminal,
  onNativeTerminalChange,
}: NativeSessionHeaderProps) {
  const t = useTranslations("Folder.conversation")
  const store = useOptionalConnectionStore()
  const { attachToConnection } = useAcpActions()
  const subscribe = useCallback(
    (listener: () => void) =>
      store ? store.subscribeKey(tabId, listener) : () => {},
    [store, tabId]
  )
  const getSnapshot = useCallback(
    () => store?.getConnection(tabId),
    [store, tabId]
  )
  const connection = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => undefined
  )
  const [pending, setPending] = useState(false)

  const connectionId = connection?.connectionId
  const source = useMemo<NativeSessionSource | null>(
    () =>
      connectionId
        ? {
            sourceConnectionId: connectionId,
            sourceConversationId: conversationId,
            sourceAgentType: agentType,
          }
        : null,
    [agentType, connectionId, conversationId]
  )

  const handleChange = useCallback(
    async (active: boolean) => {
      if (pending) return
      if (active) {
        // 已经是原生视图时忽略重复点击，避免再开一个 PTY。
        if (nativeTerminal) return
        if (!source) return
        setPending(true)
        try {
          const opened = await openNativeMainSession(getTransport(), source)
          onNativeTerminalChange(opened)
        } catch (error) {
          console.error("[NativeSessionHeader] open main terminal:", error)
          toast.error(t("nativeTerminalOpenFailed"), {
            description: toErrorMessage(error),
          })
        } finally {
          setPending(false)
        }
        return
      }
      // 关键：ACP 在进入终端时已被后端断开，store 里通常没有 source 了；
      // 关闭只能依赖句柄里保存的原连接 id。
      if (!nativeTerminal) return
      setPending(true)
      try {
        // 等待原生进程释放会话后再显示 ACP，避免两个写入者同时接管。
        const restored = await closeNativeMainSession(
          getTransport(),
          nativeTerminal.sourceConnectionId,
          nativeTerminal.terminalId
        )
        // 后端已用原 session 恢复了新连接。先按 id 被动挂回 store，避免
        // 随后自动重连的 fast path 继续复用终端前的旧连接 id。
        try {
          await attachToConnection(
            tabId,
            restored.connectionId,
            agentType,
            workingDir ?? folderPath ?? null
          )
        } catch (error) {
          // attach 失败也回到 ACP，让正常重连流程兜底。
          console.error("[NativeSessionHeader] attach restored ACP:", error)
        }
        onNativeTerminalChange(null, restored.connectionId)
      } catch (error) {
        console.error("[NativeSessionHeader] close main terminal:", error)
        toast.error(t("nativeTerminalCloseFailed"), {
          description: toErrorMessage(error),
        })
      } finally {
        setPending(false)
      }
    },
    [
      agentType,
      attachToConnection,
      folderPath,
      nativeTerminal,
      onNativeTerminalChange,
      pending,
      source,
      t,
      tabId,
      workingDir,
    ]
  )

  return (
    <ConversationDetailHeader
      tabId={tabId}
      conversationId={conversationId}
      runtimeConversationId={runtimeConversationId}
      folderId={folderId}
      folderPath={folderPath}
      title={title}
      status={status}
      agentType={agentType}
      nativeViewActive={nativeTerminal != null}
      // 有句柄就允许切回，不能再依赖已被后端移除的 store 连接。
      nativeViewAvailable={nativeTerminal != null || source != null}
      // 终端期间即使 store 里还残留旧连接，也不能把它当成"忙碌"卡住切回。
      nativeViewBusy={
        pending ||
        (nativeTerminal == null && connection?.status === "prompting")
      }
      onNativeViewChange={handleChange}
    />
  )
}

interface NativeAttachedTerminalProps {
  terminalId: string
  workingDir: string
  isActive: boolean
  isVisible: boolean
  className?: string
}

/**
 * 复用已有 PTY 的原生终端。卡片属于会话，`attach` 只接管、不在卸载时 kill；
 * 后端已打开的终端丢失时也不兜底 spawn，避免一个视图意外重启 CLI。
 */
export function NativeAttachedTerminal({
  terminalId,
  workingDir,
  isActive,
  isVisible,
  className,
}: NativeAttachedTerminalProps) {
  return (
    <div
      className={cn("relative flex min-h-0 flex-col bg-background", className)}
    >
      <TerminalView
        key={terminalId}
        terminalId={terminalId}
        workingDir={workingDir}
        isActive={isActive}
        isVisible={isVisible}
        attach
        spawnOnMissing={false}
        reuseCompleted
      />
    </div>
  )
}

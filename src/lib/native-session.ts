import type { AgentType } from "@/lib/types"
import type { Transport } from "@/lib/transport/types"

/** 已确认支持原生终端会话的四个 CLI。 */
export const NATIVE_TERMINAL_AGENTS = [
  "codex",
  "claude_code",
  "pi",
  "deepseek",
] as const

export function supportsNativeTerminal(agentType: string): boolean {
  return (NATIVE_TERMINAL_AGENTS as readonly string[]).includes(agentType)
}

export interface NativeSessionSource {
  sourceConnectionId: string
  sourceConversationId: number | null
  sourceAgentType: AgentType
}

/**
 * 后端返回的旁问身份。terminalId 不在列表结果里：关闭后的历史仍需展示，
 * 只有 open/create 才拿得到当前 PTY。
 */
export interface NativeSideQuestion {
  id: string
  sourceSessionId: string
  branchSessionId: string
  agentType: AgentType
  cwd: string
  title: string
  isOpen: boolean
}

export interface NativeCreatedSideQuestion {
  sideQuestion: NativeSideQuestion
  terminalId: string
}

export interface NativeTerminalHandle {
  terminalId: string
}

/**
 * 主线原生终端句柄。除了 PTY 自身，还保存进入终端前的 ACP 连接 id：
 * 后端切到终端后会释放该连接，store 里不再有可用条目，关闭终端时只能靠
 * 这份句柄把 ACP 会话重新关联回来。
 */
export interface NativeMainTerminal {
  terminalId: string
  sourceConnectionId: string
}

/** 终端退出后后端恢复出来的 ACP 连接。 */
export interface NativeRestoredAcp {
  connectionId: string
}

export function listNativeSideQuestions(
  transport: Transport,
  source: NativeSessionSource
): Promise<NativeSideQuestion[]> {
  return transport.call("native_session_list", { ...source })
}

export function createNativeSideQuestion(
  transport: Transport,
  source: NativeSessionSource,
  request: { requestId: string; title: string }
): Promise<NativeCreatedSideQuestion> {
  return transport.call(
    "native_session_create_side",
    { ...source, ...request },
    { timeoutMs: 180_000 }
  )
}

export function openNativeSideQuestion(
  transport: Transport,
  sideQuestionId: string
): Promise<NativeTerminalHandle> {
  return transport.call("native_session_open_side", { sideQuestionId })
}

export function closeNativeSideQuestion(
  transport: Transport,
  sideQuestionId: string
): Promise<void> {
  return transport.call("native_session_close_side", { sideQuestionId })
}

export function openNativeMainSession(
  transport: Transport,
  source: NativeSessionSource
): Promise<NativeMainTerminal> {
  return transport
    .call<NativeTerminalHandle>("native_session_open_main", { ...source })
    .then(({ terminalId }) => ({
      terminalId,
      // 后端只返回 PTY；来源连接 id 由前端补回，供关闭时稳定使用。
      sourceConnectionId: source.sourceConnectionId,
    }))
}

export function closeNativeMainSession(
  transport: Transport,
  sourceConnectionId: string,
  terminalId: string
): Promise<NativeRestoredAcp> {
  return transport.call<NativeRestoredAcp>("native_session_close_main", {
    sourceConnectionId,
    terminalId,
  })
}

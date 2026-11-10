import { getActiveRemoteConnectionId } from "@/lib/transport"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"
import type { ForkPromptSnapshot } from "@/lib/research-branch"

function key(conversationId: number, sourceTurnId?: string): string {
  const backend = getActiveRemoteConnectionId() ?? "local"
  return `research-branch:pending:${backend}:${conversationId}${sourceTurnId ? `:prompt:${sourceTurnId}` : ""}`
}

const pending = new Map<string, string>()
const pendingPrompts = new Map<string, string>()

export function pendingResearchCreation(
  conversationId: number,
  sourceTurnId?: string,
  sourcePrompt?: ForkPromptSnapshot
): string | null {
  const storageKey = key(conversationId, sourceTurnId)
  const active = pending.get(storageKey)
  const expected = sourcePrompt ? JSON.stringify(sourcePrompt) : null
  if (active)
    return expected === null || pendingPrompts.get(storageKey) === expected
      ? active
      : null
  try {
    if (
      expected !== null &&
      sessionStorage.getItem(`${storageKey}:snapshot`) !== expected
    )
      return null
    return sessionStorage.getItem(storageKey)
  } catch {
    return null
  }
}

export function rememberResearchCreation(
  conversationId: number,
  requestId: string,
  sourceTurnId?: string,
  sourcePrompt?: ForkPromptSnapshot
): void {
  const storageKey = key(conversationId, sourceTurnId)
  // 原生 fork 可能在页面离开后完成，刷新或重连重试必须复用原编号。
  pending.set(storageKey, requestId)
  // 位置 ID 会在压缩后复用，只有同一条消息才能复用未完成的请求编号。
  const snapshot = sourcePrompt ? JSON.stringify(sourcePrompt) : ""
  pendingPrompts.set(storageKey, snapshot)
  try {
    sessionStorage.setItem(storageKey, requestId)
    sessionStorage.setItem(`${storageKey}:snapshot`, snapshot)
  } catch {
    // 存储受限时仍保留本页面生命周期内的幂等凭据。
  }
}

export function finishResearchCreation(
  conversationId: number,
  requestId: string,
  sourceTurnId?: string
): void {
  if (pendingResearchCreation(conversationId, sourceTurnId) !== requestId)
    return
  const storageKey = key(conversationId, sourceTurnId)
  pending.delete(storageKey)
  pendingPrompts.delete(storageKey)
  try {
    sessionStorage.removeItem(storageKey)
    sessionStorage.removeItem(`${storageKey}:snapshot`)
  } catch {
    // 内存凭据已清理，下一次成功查询仍可从后端关系恢复。
  }
}

export function clearResearchCreationCache(): void {
  pending.clear()
  pendingPrompts.clear()
}

registerBackendScopedStoreReset(clearResearchCreationCache)

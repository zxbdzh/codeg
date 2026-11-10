import { getActiveRemoteConnectionId } from "@/lib/transport"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"

function key(conversationId: number): string {
  const backend = getActiveRemoteConnectionId() ?? "local"
  return `research-branch:pending:${backend}:${conversationId}`
}

const pending = new Map<string, string>()

export function pendingResearchCreation(conversationId: number): string | null {
  const storageKey = key(conversationId)
  const active = pending.get(storageKey)
  if (active) return active
  try {
    return sessionStorage.getItem(storageKey)
  } catch {
    return null
  }
}

export function rememberResearchCreation(
  conversationId: number,
  requestId: string
): void {
  const storageKey = key(conversationId)
  // 原生 fork 可能在页面离开后完成，刷新或重连重试必须复用原编号。
  pending.set(storageKey, requestId)
  try {
    sessionStorage.setItem(storageKey, requestId)
  } catch {
    // 存储受限时仍保留本页面生命周期内的幂等凭据。
  }
}

export function finishResearchCreation(
  conversationId: number,
  requestId: string
): void {
  if (pendingResearchCreation(conversationId) !== requestId) return
  const storageKey = key(conversationId)
  pending.delete(storageKey)
  try {
    sessionStorage.removeItem(storageKey)
  } catch {
    // 内存凭据已清理，下一次成功查询仍可从后端关系恢复。
  }
}

export function clearResearchCreationCache(): void {
  pending.clear()
}

registerBackendScopedStoreReset(clearResearchCreationCache)

import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"

export const FORK_PROMPT_READY_EVENT = "codeg:fork-prompt-ready"

const pending = new Map<number, string>()
const forkPromptDrafts = new Map<string, string>()

export function parkForkPromptDraft(tabId: string, text: string): void {
  forkPromptDrafts.set(tabId, text)
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(FORK_PROMPT_READY_EVENT))
}

export function consumeForkPromptDraft(tabId: string): string | null {
  const text = forkPromptDrafts.get(tabId) ?? null
  forkPromptDrafts.delete(tabId)
  return text
}

export function parkForkConversationPrompt(
  conversationId: number,
  text: string
): void {
  pending.set(conversationId, text)
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(FORK_PROMPT_READY_EVENT, {
        detail: { conversationId },
      })
    )
  }
}

export function consumeForkConversationPrompt(
  conversationId: number
): string | null {
  const prompt = pending.get(conversationId) ?? null
  pending.delete(conversationId)
  return prompt
}

export function clearForkPromptHandoffs(): void {
  pending.clear()
  forkPromptDrafts.clear()
}

registerBackendScopedStoreReset(clearForkPromptHandoffs)

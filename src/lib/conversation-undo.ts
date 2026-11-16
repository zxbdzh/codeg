import { getTransport } from "@/lib/transport"
import type { ForkPromptSnapshot } from "@/lib/research-branch"

export interface ConversationUndoRequest {
  conversationId: number
  sourceTurnId: string
  sourcePrompt: ForkPromptSnapshot
}

export interface ConversationUndoResult {
  conversationId: number
  sessionId: string
}

export function undoConversation(
  request: ConversationUndoRequest
): Promise<ConversationUndoResult> {
  return getTransport().call(
    "conversation_undo",
    { ...request },
    {
      timeoutMs: 30 * 60_000,
    }
  )
}

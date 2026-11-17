import { getTransport } from "@/lib/transport"
import type { ForkPromptSnapshot } from "@/lib/research-branch"
import type { MessageTurn, PromptStashSnapshot } from "@/lib/types"

export interface ConversationUndoPreview {
  conversationId: number
  sessionId: string
  sourceTurnId: string
  historyRevision: string
  affectedTurns: number
  affectedUserMessages: number
  prompt: MessageTurn
  issues?: Array<{ code: string; label: string }>
  tasks?: Array<{ id: string; kind: string; label: string | null }>
}

export function previewConversationUndo(request: {
  conversationId: number
  sourceTurnId: string
}): Promise<ConversationUndoPreview> {
  return getTransport().call("conversation_undo_preview", { ...request })
}

export interface ConversationUndoRequest {
  conversationId: number
  sourceTurnId: string
  sourcePrompt: ForkPromptSnapshot
}

export interface ConversationUndoResult {
  conversationId: number
  sessionId: string
  prompt?: MessageTurn
}

export interface PreparedConversationUndoRequest {
  conversationId: number
  sourceTurnId: string
  historyRevision: string
  currentDraft: PromptStashSnapshot | null
  stopConfirmed: boolean
}

export function commitConversationUndo(
  request: PreparedConversationUndoRequest
): Promise<ConversationUndoResult> {
  return getTransport().call("conversation_undo_commit", { ...request })
}

export interface ConversationRedoStatus {
  available: boolean
  hasBackup: boolean
  expiresAt: string | null
}

export function readConversationRedoStatus(
  conversationId: number
): Promise<ConversationRedoStatus> {
  return getTransport().call("conversation_redo_status", { conversationId })
}

export function redoConversation(
  conversationId: number
): Promise<ConversationUndoResult> {
  return getTransport().call("conversation_redo", { conversationId })
}

export function clearConversationRedo(conversationId: number): Promise<void> {
  return getTransport().call("conversation_redo_clear", { conversationId })
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

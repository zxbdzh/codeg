import { getTransport } from "@/lib/transport"
import type { MessageTurn } from "@/lib/types"

export interface ForkPromptSnapshot {
  text: string
  timestamp: string
  agentMessageId: string | null
}

export function snapshotForkPrompt(turn: MessageTurn): ForkPromptSnapshot {
  return {
    text: turn.blocks
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n"),
    timestamp: turn.timestamp,
    agentMessageId: turn.agent_message_id ?? null,
  }
}

export interface ResearchBranchInfo {
  id: number
  sourceConversationId: number
  branchConversationId: number
  sourceSessionId: string
  branchSessionId: string
  sourceTurnId: string | null
  boundary: "session_tail" | "before_prompt"
  title: string
  sourceTitle: string
  createdAt: string
}

export interface CreateResearchBranchRequest {
  connectionId: string
  sourceConversationId: number
  requestId: string
  sourceTurnId?: string
  sourcePrompt?: ForkPromptSnapshot
}

export function createResearchBranch(
  request: CreateResearchBranchRequest
): Promise<ResearchBranchInfo> {
  return getTransport().call(
    "conversation_fork",
    { ...request },
    { timeoutMs: 30 * 60_000 }
  )
}

import type { ConversationTimelineTurn } from "@/stores/conversation-runtime-store"
import type { AgentType } from "@/lib/types"
import type { Transport } from "@/lib/transport/types"

export const SIDE_QUESTION_MAX_MESSAGES = 12
export const SIDE_QUESTION_MAX_CONTEXT_CHARS = 12_000
export const SIDE_QUESTION_MAX_SELECTION_CHARS = 8_000
export const SIDE_QUESTION_MAX_QUESTION_CHARS = 4_000

export interface SideQuestionContextEntry {
  role: "user" | "assistant"
  text: string
}

export interface SideQuestionRequest {
  requestId: string
  question: string
  selection: string | null
  context: SideQuestionContextEntry[]
}

export interface SideQuestionAnswer {
  answer: string
  agentType: AgentType
  contextMessages: number
  contextChars: number
  selectionChars: number
}

export interface SideQuestionSettings {
  configValues: Record<string, string>
}

export function getSideQuestionSettings(
  transport: Transport
): Promise<SideQuestionSettings> {
  return transport.call("get_side_question_settings")
}

export function setSideQuestionSettings(
  transport: Transport,
  settings: SideQuestionSettings
): Promise<SideQuestionSettings> {
  return transport.call("set_side_question_settings", { settings })
}

export function unicodeLength(text: string): number {
  return Array.from(text).length
}

export function truncateSideQuestionSelection(text: string): string {
  return Array.from(text).slice(0, SIDE_QUESTION_MAX_SELECTION_CHARS).join("")
}

/** 只快照已提交的正文；主任务的流式片段、工具结果和思考不进入旁问。 */
export function buildSideQuestionContext(
  timeline: readonly ConversationTimelineTurn[]
): SideQuestionContextEntry[] {
  const entries: SideQuestionContextEntry[] = []
  let remaining = SIDE_QUESTION_MAX_CONTEXT_CHARS
  for (
    let index = timeline.length - 1;
    index >= 0 && entries.length < SIDE_QUESTION_MAX_MESSAGES && remaining > 0;
    index -= 1
  ) {
    const item = timeline[index]
    if (item.phase !== "persisted" || item.isInFlightRound) continue
    const { turn } = item
    if (turn.role !== "user" && turn.role !== "assistant") continue
    const text = turn.blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim()
    if (!text) continue
    const chars = Array.from(text)
    const kept = chars.slice(-remaining)
    entries.push({ role: turn.role, text: kept.join("") })
    remaining -= kept.length
  }
  return entries.reverse()
}

export function askSideQuestion(
  transport: Transport,
  request: SideQuestionRequest
): Promise<SideQuestionAnswer> {
  return transport.call(
    "side_question_ask",
    { ...request },
    { timeoutMs: 30 * 60_000 }
  )
}

export function cancelSideQuestionRequest(
  transport: Transport,
  requestId: string
): Promise<void> {
  return transport.call("side_question_cancel", { requestId })
}

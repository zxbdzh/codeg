import { getTransport } from "@/lib/transport"
import type { ConversationTagDetail, TagDimension } from "@/lib/types"

type TagEdit = {
  name?: string | null
  color?: string | null
  dimension?: TagDimension | null
}

type TagChange = { tagId: number } & (
  | {
      kind: "create"
      folderId: number | null
      name: string
      color: string
      dimension: TagDimension
    }
  | ({ kind: "update" } & TagEdit)
  | { kind: "delete" }
  | { kind: "merge"; targetId: number }
  | { kind: "add" | "remove"; conversationId: number }
)

export interface CurationItem {
  change: TagChange
  before: ConversationTagDetail | null
  target: ConversationTagDetail | null
  affected: { id: number; title: string | null; manual: boolean }[]
}

export interface CurationJob {
  id: string
  state: "queued" | "running" | "review" | "failed" | "applied" | "undone"
  createdAt: number
  scanned: number
  total: number
  items: CurationItem[]
  notices: {
    id: number
    title: string | null
    count: number
    dimension: TagDimension
  }[]
  error:
    | "configuration"
    | "unauthorized"
    | "not_found"
    | "malformed"
    | "transport"
    | "interrupted"
    | "database"
    | null
}

export interface CurationChoice {
  index: number
  name?: string
  color?: string
  dimension?: TagDimension
  targetId?: number
  confirmManual?: boolean
  confirmDelete?: boolean
}

export type CurationRequest =
  | { action: "status" }
  | { action: "start" }
  | { action: "history" }
  | { action: "retry" | "discard" | "undo" | "purge"; id: string }
  | { action: "apply"; id: string; choices: CurationChoice[] }
  | { action: "set_protection"; tagIds: number[]; protected: boolean }

type Outcome = { id: string; tagIds: number[]; conversationIds: number[] }

type Response = {
  status: CurationJob | null
  start: CurationJob
  history: CurationJob[]
  retry: CurationJob
  discard: null
  apply: Outcome
  undo: Outcome
  purge: null
  set_protection: null
}

export function requestTagCuration<Request extends CurationRequest>(
  request: Request
): Promise<Response[Request["action"]]> {
  return getTransport().call("tag_curation", { request })
}

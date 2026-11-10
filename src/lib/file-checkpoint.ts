import { getTransport } from "@/lib/transport"

export interface FileCheckpoint {
  id: string
  createdAt: string
  label: string
  conversationId: number
  fileCount: number
  bytes: number
}

export interface FileCheckpointEntry {
  path: string
  change: "added" | "modified" | "deleted"
  beforeText: string | null
  afterText: string | null
  binary: boolean
}

export interface FileCheckpointPlan {
  id: string
  checkpointId: string
  entries: FileCheckpointEntry[]
}

export interface FileCheckpointResponse {
  enabled: boolean
  root: string
  checkpoints: FileCheckpoint[]
  lastRestoreId: string | null
  plan?: FileCheckpointPlan
}

export type FileCheckpointOperation =
  | { action: "list" | "enable" | "disable" | "capture" }
  | { action: "preview" | "delete"; checkpointId: string }
  | { action: "undo"; planId: string }
  | { action: "apply"; planId: string; paths: string[] }

export type FileCheckpointRequest = FileCheckpointOperation & {
  conversationId: number
}

export async function fileCheckpoint(
  request: FileCheckpointRequest
): Promise<FileCheckpointResponse> {
  if (
    !Number.isSafeInteger(request.conversationId) ||
    request.conversationId <= 0
  ) {
    throw new Error("A persisted conversation is required for file checkpoints")
  }
  // 始终走工作区传输，远程桌面也不能误用本机或供应商的文件 API。
  return getTransport().call(
    "file_checkpoint",
    { request },
    { timeoutMs: 120_000 }
  )
}

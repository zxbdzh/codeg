import {
  blobToBase64,
  mimeTypeFromPath,
} from "@/components/chat/composer/attachment-files"
import { randomUUID } from "@/lib/utils"

export const SIDE_ATTACHMENT_MAX_COUNT = 4
export const SIDE_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024
export const SIDE_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024
export const SIDE_ATTACHMENT_MAX_TEXT_CHARS = 32_000
export const SIDE_ATTACHMENT_ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp,.txt,.md,.json,.yaml,.yml,.csv,.html,.css,.js,.mjs,.cjs,.ts,.tsx,.jsx,.py,.rs,.go,.java,.xml,.toml,.log"

export type SideQuestionAttachment =
  | { type: "image"; name: string; mimeType: string; data: string }
  | { type: "text"; name: string; mimeType: string; text: string }

export type SideQuestionDraftAttachment = SideQuestionAttachment & {
  id: string
  bytes: number
}

export type SideAttachmentError =
  | "unsupportedFile"
  | "attachmentTooLarge"
  | "tooManyAttachments"
  | "attachmentReadFailed"

const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
])
const textTypes = new Set([
  "application/json",
  "application/yaml",
  "application/xml",
  "application/toml",
])

export function validateSideAttachmentBatch(
  current: readonly SideQuestionDraftAttachment[],
  incoming: readonly { size: number }[]
): SideAttachmentError | null {
  if (current.length + incoming.length > SIDE_ATTACHMENT_MAX_COUNT)
    return "tooManyAttachments"
  if (
    incoming.some((file) => file.size > SIDE_ATTACHMENT_MAX_BYTES) ||
    current.reduce((sum, item) => sum + item.bytes, 0) +
      incoming.reduce((sum, item) => sum + item.size, 0) >
      SIDE_ATTACHMENT_TOTAL_BYTES
  )
    return "attachmentTooLarge"
  return null
}

export async function readSideQuestionAttachment(
  file: File
): Promise<SideQuestionDraftAttachment> {
  if (file.size > SIDE_ATTACHMENT_MAX_BYTES)
    throw new Error("attachmentTooLarge" satisfies SideAttachmentError)
  const inferred = mimeTypeFromPath(file.name)
  const mimeType =
    imageTypes.has(file.type) ||
    file.type.startsWith("text/") ||
    textTypes.has(file.type)
      ? file.type
      : inferred || (/\.log$/i.test(file.name) ? "text/plain" : file.type)
  const common = {
    id: randomUUID(),
    name: file.name,
    mimeType,
    bytes: file.size,
  }
  if (imageTypes.has(mimeType))
    return { ...common, type: "image", data: await blobToBase64(file) }
  if (!mimeType.startsWith("text/") && !textTypes.has(mimeType))
    throw new Error("unsupportedFile" satisfies SideAttachmentError)
  const encoded = await blobToBase64(file)
  const bytes = Uint8Array.from(atob(encoded), (character) =>
    character.charCodeAt(0)
  )
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error("unsupportedFile" satisfies SideAttachmentError)
  }
  if (Array.from(text).length > SIDE_ATTACHMENT_MAX_TEXT_CHARS)
    throw new Error("attachmentTooLarge" satisfies SideAttachmentError)
  if (text.includes("\0"))
    throw new Error("unsupportedFile" satisfies SideAttachmentError)
  return { ...common, type: "text", text }
}

export function sideAttachmentPayload(
  attachment: SideQuestionDraftAttachment
): SideQuestionAttachment {
  return attachment.type === "image"
    ? {
        type: "image",
        name: attachment.name,
        mimeType: attachment.mimeType,
        data: attachment.data,
      }
    : {
        type: "text",
        name: attachment.name,
        mimeType: attachment.mimeType,
        text: attachment.text,
      }
}

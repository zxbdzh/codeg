import { describe, expect, it } from "vitest"
import {
  readSideQuestionAttachment,
  sideAttachmentPayload,
  validateSideAttachmentBatch,
  SIDE_ATTACHMENT_MAX_BYTES,
} from "./side-question-attachments"

describe("side-question attachments", () => {
  it("reads image bytes for native vision input and strips client-only fields", async () => {
    const file = new File(["image bytes"], "screen.png", { type: "image/png" })
    const attachment = await readSideQuestionAttachment(file)
    expect(sideAttachmentPayload(attachment)).toEqual({
      type: "image",
      name: "screen.png",
      mimeType: "image/png",
      data: btoa("image bytes"),
    })
  })

  it("embeds UTF-8 code files instead of creating file-system references", async () => {
    const attachment = await readSideQuestionAttachment(
      new File(["const answer = '你好'"], "code.ts", {
        type: "application/octet-stream",
      })
    )
    expect(sideAttachmentPayload(attachment)).toEqual({
      type: "text",
      name: "code.ts",
      mimeType: "text/typescript",
      text: "const answer = '你好'",
    })
  })

  it("rejects unsupported binary files, invalid UTF-8 and oversized content", async () => {
    await expect(
      readSideQuestionAttachment(new File(["binary"], "archive.zip"))
    ).rejects.toThrow("unsupportedFile")
    await expect(
      readSideQuestionAttachment(
        new File([new Uint8Array([0xff, 0xfe])], "invalid.txt", {
          type: "text/plain",
        })
      )
    ).rejects.toThrow("unsupportedFile")
    await expect(
      readSideQuestionAttachment(
        new File(["x".repeat(32_001)], "long.txt", { type: "text/plain" })
      )
    ).rejects.toThrow("attachmentTooLarge")
    expect(
      validateSideAttachmentBatch(
        [],
        Array.from({ length: 5 }, () => ({ size: 1 }))
      )
    ).toBe("tooManyAttachments")
    expect(
      validateSideAttachmentBatch([], [{ size: SIDE_ATTACHMENT_MAX_BYTES + 1 }])
    ).toBe("attachmentTooLarge")
    expect(
      validateSideAttachmentBatch(
        [],
        [
          { size: SIDE_ATTACHMENT_MAX_BYTES },
          { size: SIDE_ATTACHMENT_MAX_BYTES },
          { size: 1 },
        ]
      )
    ).toBe("attachmentTooLarge")
  })
})

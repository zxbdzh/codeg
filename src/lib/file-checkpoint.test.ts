import { beforeEach, describe, expect, it, vi } from "vitest"

const transport = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock("@/lib/transport", () => ({ getTransport: () => transport }))

import {
  fileCheckpoint,
  type FileCheckpointOperation,
  type FileCheckpointResponse,
} from "./file-checkpoint"

beforeEach(() => {
  transport.call.mockReset()
})

describe("file checkpoint API", () => {
  it.each<FileCheckpointOperation>([
    { action: "list" },
    { action: "enable" },
    { action: "disable" },
    { action: "capture" },
    { action: "preview", checkpointId: "other-conversation-snapshot" },
    { action: "delete", checkpointId: "snapshot-1" },
    { action: "undo", planId: "last-restore-1" },
    { action: "apply", planId: "preview-1", paths: ["src/中文 file.ts"] },
  ])("uses the portable transport envelope for $action", async (operation) => {
    const response: FileCheckpointResponse = {
      enabled: true,
      root: "F:\\workspace",
      checkpoints: [],
      lastRestoreId: null,
    }
    transport.call.mockResolvedValue(response)
    const request = { conversationId: 10, ...operation }

    expect(await fileCheckpoint(request)).toBe(response)
    expect(transport.call).toHaveBeenCalledExactlyOnceWith(
      "file_checkpoint",
      { request },
      { timeoutMs: 120_000 }
    )
  })

  it("preserves the before/current and after/target plan without swapping restore direction", async () => {
    const response = {
      enabled: false,
      root: "/workspace",
      checkpoints: [],
      lastRestoreId: "undo-1",
      plan: {
        id: "plan-1",
        checkpointId: "snapshot-1",
        entries: [
          {
            path: "new.txt",
            change: "added",
            beforeText: null,
            afterText: "target",
            binary: false,
          },
          {
            path: "old.txt",
            change: "deleted",
            beforeText: "current",
            afterText: null,
            binary: false,
          },
        ],
      },
    }
    transport.call.mockResolvedValue(response)
    expect(
      await fileCheckpoint({
        conversationId: 20,
        action: "preview",
        checkpointId: "snapshot-1",
      })
    ).toBe(response)
  })

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects non-persisted conversation IDs before transport: %s",
    async (conversationId) => {
      await expect(
        fileCheckpoint({ conversationId, action: "list" })
      ).rejects.toThrow("persisted conversation")
      expect(transport.call).not.toHaveBeenCalled()
    }
  )

  it("preserves backend failures without automatically retrying a write", async () => {
    const failure = new Error("Workspace changed; preview again")
    transport.call.mockRejectedValue(failure)
    await expect(
      fileCheckpoint({
        conversationId: 10,
        action: "apply",
        planId: "expired-plan",
        paths: ["a.txt"],
      })
    ).rejects.toBe(failure)
    expect(transport.call).toHaveBeenCalledTimes(1)
  })
})

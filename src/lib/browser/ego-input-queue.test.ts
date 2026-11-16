import { describe, expect, it, vi } from "vitest"

import { EgoInputQueue } from "./ego-input-queue"

describe("Ego 低延迟输入队列", () => {
  it("只保留尚未发送的最新移动，不丢点击、输入和释放的顺序", async () => {
    let release: () => void = () => {}
    const calls: string[] = []
    const queue = new EgoInputQueue()
    const first = queue.push(
      "page",
      { kind: "text", text: "first" },
      async () => {
        calls.push("first")
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
    )
    await vi.waitFor(() => expect(calls).toEqual(["first"]))
    const pending = []
    for (let index = 0; index < 50; index += 1) {
      pending.push(
        queue.push(
          "page",
          { kind: "pointer", type: "mouseMoved", x: index },
          async (action) => {
            calls.push(`move-${action.x}`)
          }
        )
      )
    }
    pending.push(
      queue.push(
        "page",
        { kind: "pointer", type: "mouseReleased" },
        async () => {
          calls.push("release")
        }
      )
    )
    pending.push(
      queue.push("page", { kind: "text", text: "last" }, async () => {
        calls.push("last")
      })
    )
    release()
    await Promise.all([first, ...pending])
    expect(calls).toEqual(["first", "move-49", "release", "last"])
    await queue.idle()
  })

  it("跨页、按键或指针释放形成边界，不合并越界操作", async () => {
    const queue = new EgoInputQueue()
    const calls: string[] = []
    await Promise.all([
      queue.push("one", { kind: "pointer", type: "mouseMoved" }, async () => {
        calls.push("one")
      }),
      queue.push("two", { kind: "pointer", type: "mouseMoved" }, async () => {
        calls.push("two")
      }),
      queue.push("two", { kind: "key", type: "keyDown" }, async () => {
        calls.push("key")
      }),
      queue.push("two", { kind: "pointer", type: "mouseMoved" }, async () => {
        calls.push("after-key")
      }),
    ])
    expect(calls).toEqual(["one", "two", "key", "after-key"])
  })

  it("连续滚动合并位移而不是丢失滚动距离", async () => {
    const queue = new EgoInputQueue()
    const calls: Record<string, unknown>[] = []
    await Promise.all(
      [10, 20, 30].map((deltaY) =>
        queue.push(
          "one",
          {
            kind: "pointer",
            type: "mouseWheel",
            deltaX: 1,
            deltaY,
            x: deltaY,
          },
          async (action) => {
            calls.push(action)
          }
        )
      )
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ deltaY: 60, deltaX: 3, x: 30 })
  })

  it("输入失败清空旧操作并允许下一轮重新排队", async () => {
    const queue = new EgoInputQueue()
    const stale = vi.fn()
    const failed = queue.push("one", { kind: "text" }, async () => {
      throw new Error("stale_control")
    })
    const pending = queue.push("one", { kind: "key" }, stale)
    await expect(failed).rejects.toThrow("stale_control")
    await expect(pending).rejects.toThrow("stale_control")
    expect(stale).not.toHaveBeenCalled()
    await queue.idle()
    await queue.push("one", { kind: "text" }, async () => {
      stale()
    })
    expect(stale).toHaveBeenCalledOnce()
  })
})

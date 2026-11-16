type Action = Record<string, unknown>
type PendingInput = {
  scope: string | null
  action: Action
  run: (action: Action) => Promise<void>
  promise: Promise<void>
  resolve: () => void
  reject: (reason: unknown) => void
}

export class EgoInputQueue {
  private pending: PendingInput[] = []
  private running = false
  private scheduled = false
  private waiters: (() => void)[] = []

  push(
    scope: string | null,
    action: Action,
    run: (action: Action) => Promise<void>
  ): Promise<void> {
    const previous = this.pending[this.pending.length - 1]
    const mergeable =
      action.kind === "pointer" &&
      ["mouseMoved", "mouseWheel"].includes(String(action.type))
    if (
      mergeable &&
      previous?.scope === scope &&
      previous.action.kind === action.kind &&
      previous.action.type === action.type &&
      previous.action.buttons === action.buttons &&
      previous.action.modifiers === action.modifiers
    ) {
      // 仅合并尚未发送的连续移动/滚动；点击、释放、按键和切页都是不可跨越的边界。
      previous.action =
        action.type === "mouseWheel"
          ? {
              ...action,
              deltaX:
                Number(previous.action.deltaX ?? 0) +
                Number(action.deltaX ?? 0),
              deltaY:
                Number(previous.action.deltaY ?? 0) +
                Number(action.deltaY ?? 0),
            }
          : action
      return previous.promise
    }
    let resolve: () => void = () => {}
    let reject: (reason: unknown) => void = () => {}
    const promise = new Promise<void>((accept, decline) => {
      resolve = accept
      reject = decline
    })
    this.pending.push({ scope, action, run, promise, resolve, reject })
    if (!this.running && !this.scheduled) {
      this.scheduled = true
      queueMicrotask(() => void this.flush())
    }
    return promise
  }

  idle(): Promise<void> {
    if (!this.running && !this.pending.length) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private async flush() {
    this.scheduled = false
    this.running = true
    while (this.pending.length) {
      const entry = this.pending.shift()!
      try {
        await entry.run(entry.action)
        entry.resolve()
      } catch (reason) {
        entry.reject(reason)
        for (const waiting of this.pending.splice(0)) waiting.reject(reason)
      }
    }
    this.running = false
    for (const resolve of this.waiters.splice(0)) resolve()
  }
}

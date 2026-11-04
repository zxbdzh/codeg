import { renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DOUBLE_SHIFT_INTERVAL_MS, useDoubleShift } from "./use-double-shift"

function shiftEvent(
  type: "keydown" | "keyup",
  init: KeyboardEventInit = {},
  target: EventTarget = document
): void {
  target.dispatchEvent(
    new KeyboardEvent(type, {
      key: "Shift",
      bubbles: true,
      cancelable: true,
      ...init,
    })
  )
}

function tapShift(
  init: KeyboardEventInit = {},
  target: EventTarget = document
): void {
  shiftEvent("keydown", init, target)
  shiftEvent("keyup", init, target)
}

describe("useDoubleShift", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("fires when Shift is tapped twice inside the window", () => {
    const onDoubleShift = vi.fn()
    renderHook(() => useDoubleShift(onDoubleShift))
    tapShift()
    vi.advanceTimersByTime(DOUBLE_SHIFT_INTERVAL_MS)
    tapShift()
    expect(onDoubleShift).toHaveBeenCalledTimes(1)
  })

  it("does not fire when the second tap is too late", () => {
    const onDoubleShift = vi.fn()
    renderHook(() => useDoubleShift(onDoubleShift))
    tapShift()
    vi.advanceTimersByTime(DOUBLE_SHIFT_INTERVAL_MS + 1)
    tapShift()
    expect(onDoubleShift).not.toHaveBeenCalled()
  })

  it("resets when another key interrupts the taps", () => {
    const onDoubleShift = vi.fn()
    renderHook(() => useDoubleShift(onDoubleShift))
    tapShift()
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true })
    )
    tapShift()
    expect(onDoubleShift).not.toHaveBeenCalled()
  })

  it("requires a release between taps, including left and right Shift", () => {
    const onDoubleShift = vi.fn()
    renderHook(() => useDoubleShift(onDoubleShift))
    shiftEvent("keydown", { code: "ShiftLeft" })
    shiftEvent("keydown", { code: "ShiftRight" })
    shiftEvent("keyup", { code: "ShiftRight" })
    shiftEvent("keyup", { code: "ShiftLeft" })
    tapShift()
    expect(onDoubleShift).not.toHaveBeenCalled()
  })

  it("does not count key repeat as a tap", () => {
    const onDoubleShift = vi.fn()
    renderHook(() => useDoubleShift(onDoubleShift))
    tapShift()
    shiftEvent("keydown")
    shiftEvent("keydown", { repeat: true })
    shiftEvent("keyup")
    tapShift()
    expect(onDoubleShift).not.toHaveBeenCalled()
  })

  it("does not count a long hold as a tap", () => {
    const onDoubleShift = vi.fn()
    renderHook(() => useDoubleShift(onDoubleShift))
    shiftEvent("keydown")
    vi.advanceTimersByTime(DOUBLE_SHIFT_INTERVAL_MS + 1)
    shiftEvent("keyup")
    tapShift()
    expect(onDoubleShift).not.toHaveBeenCalled()
  })

  it.each(["ctrlKey", "altKey", "metaKey", "isComposing"])(
    "rejects Shift with %s held",
    (modifier) => {
      const onDoubleShift = vi.fn()
      renderHook(() => useDoubleShift(onDoubleShift))
      tapShift()
      tapShift({ [modifier]: true })
      tapShift()
      expect(onDoubleShift).not.toHaveBeenCalled()
    }
  )

  it("does not treat Shift with horizontal scrolling as a tap", () => {
    const onDoubleShift = vi.fn()
    renderHook(() => useDoubleShift(onDoubleShift))
    tapShift()
    shiftEvent("keydown")
    document.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, shiftKey: true, deltaY: 100 })
    )
    shiftEvent("keyup")
    tapShift()
    expect(onDoubleShift).not.toHaveBeenCalled()
  })

  it.each(["pointerdown", "compositionstart", "blur", "wheel"])(
    "resets on %s",
    (type) => {
      const onDoubleShift = vi.fn()
      renderHook(() => useDoubleShift(onDoubleShift))
      tapShift()
      const target = type === "blur" ? window : document
      target.dispatchEvent(new Event(type, { bubbles: true }))
      tapShift()
      expect(onDoubleShift).not.toHaveBeenCalled()
    }
  )

  it("needs two new taps after firing", () => {
    const onDoubleShift = vi.fn()
    renderHook(() => useDoubleShift(onDoubleShift))
    tapShift()
    tapShift()
    tapShift()
    expect(onDoubleShift).toHaveBeenCalledTimes(1)
  })

  it("stops listening when disabled and resets on re-enable", () => {
    const onDoubleShift = vi.fn()
    const { rerender } = renderHook(
      ({ enabled }) => useDoubleShift(onDoubleShift, enabled),
      { initialProps: { enabled: true } }
    )
    tapShift()
    rerender({ enabled: false })
    tapShift()
    rerender({ enabled: true })
    tapShift()
    expect(onDoubleShift).not.toHaveBeenCalled()
    tapShift()
    expect(onDoubleShift).toHaveBeenCalledTimes(1)
  })

  it("uses the latest callback and cleans up on unmount", () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender, unmount } = renderHook(
      ({ callback }) => useDoubleShift(callback),
      { initialProps: { callback: first } }
    )
    tapShift()
    rerender({ callback: second })
    tapShift()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    unmount()
    tapShift()
    tapShift()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it("hears the gesture when an inner element stops propagation", () => {
    const onDoubleShift = vi.fn()
    const surface = document.createElement("div")
    document.body.appendChild(surface)
    surface.addEventListener("keydown", (event) => event.stopPropagation())
    surface.addEventListener("keyup", (event) => event.stopPropagation())
    try {
      renderHook(() => useDoubleShift(onDoubleShift))
      tapShift({}, surface)
      tapShift({}, surface)
      expect(onDoubleShift).toHaveBeenCalledTimes(1)
    } finally {
      surface.remove()
    }
  })
})

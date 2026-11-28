import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { usePanelSlideOnToggle } from "./use-panel-slide-on-toggle"

afterEach(() => vi.useRealTimers())

describe("panel slide on toggle", () => {
  // jsdom 不测帧耗：这里只锁定路由恢复误触发尺寸过渡的条件。
  it("restores panels without animation across workbench routes", () => {
    const { result, rerender } = renderHook(
      ({ conversations }) =>
        usePanelSlideOnToggle(conversations, true, conversations),
      { initialProps: { conversations: true } }
    )
    expect(result.current).toBe(false)
    rerender({ conversations: false })
    expect(result.current).toBe(false)
    rerender({ conversations: true })
    expect(result.current).toBe(false)
  })

  it("keeps explicit toggles animated and restarts their timer", () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      ({ open }) => usePanelSlideOnToggle(open, true),
      { initialProps: { open: false } }
    )
    rerender({ open: true })
    expect(result.current).toBe(true)
    act(() => vi.advanceTimersByTime(200))
    rerender({ open: false })
    act(() => vi.advanceTimersByTime(100))
    expect(result.current).toBe(true)
    act(() => vi.advanceTimersByTime(200))
    expect(result.current).toBe(false)
  })

  it("cancels an in-flight toggle when leaving the route", () => {
    const { result, rerender } = renderHook(
      ({ open, conversations }) =>
        usePanelSlideOnToggle(open && conversations, true, conversations),
      { initialProps: { open: false, conversations: true } }
    )
    rerender({ open: true, conversations: true })
    expect(result.current).toBe(true)
    rerender({ open: true, conversations: false })
    expect(result.current).toBe(false)
    rerender({ open: true, conversations: true })
    expect(result.current).toBe(false)
  })

  it("adopts restored state without animating", () => {
    const { result, rerender } = renderHook(
      ({ open, ready }) => usePanelSlideOnToggle(open, ready),
      { initialProps: { open: false, ready: false } }
    )
    rerender({ open: true, ready: true })
    expect(result.current).toBe(false)
  })
})

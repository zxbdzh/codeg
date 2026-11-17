import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { useEgoDisplaySize } from "./use-ego-display-size"

afterEach(() => vi.unstubAllGlobals())

describe("Ego 手机全屏可用尺寸", () => {
  it("方向锁已返回但屏幕仍竖向时保留横屏回退，键盘不改变页面设备尺寸", () => {
    const orientation = Object.assign(new EventTarget(), {
      type: "landscape-primary",
    })
    const device = { width: 390, height: 844, orientation }
    const viewport = Object.assign(new EventTarget(), {
      width: 390,
      height: 844,
    })
    vi.stubGlobal("screen", device)
    vi.stubGlobal("innerWidth", 390)
    vi.stubGlobal("innerHeight", 844)
    vi.stubGlobal("visualViewport", viewport)
    const { result } = renderHook(() => useEgoDisplaySize(true))
    expect(result.current.portrait).toBe(true)
    act(() => {
      viewport.height = 300
      viewport.dispatchEvent(new Event("resize"))
    })
    expect(result.current.height).toBe(300)
    expect(result.current.deviceWidth).toBe(390)
    expect(result.current.deviceHeight).toBe(844)
    expect(result.current.portrait).toBe(true)
    act(() => {
      device.width = 844
      device.height = 390
      orientation.dispatchEvent(new Event("change"))
    })
    expect(result.current.portrait).toBe(true)
    act(() => {
      vi.stubGlobal("innerWidth", 844)
      vi.stubGlobal("innerHeight", 390)
      orientation.dispatchEvent(new Event("change"))
    })
    expect(result.current.portrait).toBe(false)
    expect(result.current.deviceWidth).toBe(390)
  })
})

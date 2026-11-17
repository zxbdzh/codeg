import { describe, expect, it } from "vitest"

import { egoPagePoint } from "./ego-display"

describe("Ego 横屏显示输入坐标", () => {
  const bounds = { left: 30, top: 100, right: 390, width: 360, height: 640 }
  const frame = { width: 1280, height: 720 }

  it("横屏回退按旋转后的字形位置定位真实页面，不交换点击目标", () => {
    expect(egoPagePoint(bounds, frame, 390, 100, true)).toEqual({
      x: 0,
      y: 0,
    })
    expect(egoPagePoint(bounds, frame, 210, 420, true)).toEqual({
      x: 640,
      y: 360,
    })
    expect(egoPagePoint(bounds, frame, 30, 740, true)).toEqual({
      x: 1279,
      y: 719,
    })
  })

  it("普通显示保留原坐标比例，超出画面时限制在真实边缘", () => {
    expect(egoPagePoint(bounds, frame, 210, 420, false)).toEqual({
      x: 640,
      y: 360,
    })
    expect(egoPagePoint(bounds, frame, -20, 1000, false)).toEqual({
      x: 0,
      y: 719,
    })
  })
})

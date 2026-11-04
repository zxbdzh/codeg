"use client"

import { useEffect, useRef } from "react"

/** 两次独立轻点之间的上限，也用于排除长按后松开的误触。 */
export const DOUBLE_SHIFT_INTERVAL_MS = 400

/**
 * IDEA 式双击 Shift：只接管当前文档的键盘事件，不注册操作系统全局热键。
 * 在捕获阶段监听，避免终端等子组件停止冒泡后丢失手势；独立 iframe / WebView
 * 的事件不会传到此文档，因此不宣称覆盖那些独立页面。
 */
export function useDoubleShift(
  onDoubleShift: () => void,
  enabled = true
): void {
  const callbackRef = useRef(onDoubleShift)
  useEffect(() => {
    callbackRef.current = onDoubleShift
  }, [onDoubleShift])

  useEffect(() => {
    if (!enabled) return

    let lastTapAt: number | null = null
    let pressedAt: number | null = null

    const reset = () => {
      lastTapAt = null
      pressedAt = null
    }
    const isModified = (event: KeyboardEvent) =>
      event.ctrlKey || event.altKey || event.metaKey || event.isComposing

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Shift" || isModified(event) || event.repeat) {
        reset()
        return
      }
      // 同时按左右 Shift 不是两次轻点；必须先松开，再开始下一次。
      if (pressedAt !== null) {
        reset()
        return
      }
      pressedAt = Date.now()
    }

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Shift" || isModified(event) || pressedAt === null) {
        reset()
        return
      }
      const now = Date.now()
      if (now - pressedAt > DOUBLE_SHIFT_INTERVAL_MS) {
        reset()
        return
      }
      pressedAt = null
      if (lastTapAt !== null && now - lastTapAt <= DOUBLE_SHIFT_INTERVAL_MS) {
        reset()
        callbackRef.current()
        return
      }
      lastTapAt = now
    }

    document.addEventListener("keydown", onKeyDown, true)
    document.addEventListener("keyup", onKeyUp, true)
    document.addEventListener("compositionstart", reset, true)
    document.addEventListener("pointerdown", reset, true)
    // Shift＋滚轮是横向滚动，不算独立轻点，避免滚动时抢走焦点。
    document.addEventListener("wheel", reset, { capture: true, passive: true })
    window.addEventListener("blur", reset)

    return () => {
      document.removeEventListener("keydown", onKeyDown, true)
      document.removeEventListener("keyup", onKeyUp, true)
      document.removeEventListener("compositionstart", reset, true)
      document.removeEventListener("pointerdown", reset, true)
      document.removeEventListener("wheel", reset, true)
      window.removeEventListener("blur", reset)
    }
  }, [enabled])
}

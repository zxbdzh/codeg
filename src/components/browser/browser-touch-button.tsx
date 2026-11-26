"use client"

import { useRef, type ButtonHTMLAttributes } from "react"

export function BrowserTouchButton({
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const press = useRef<{ id: number; x: number; y: number } | null>(null)
  return (
    <button
      type="button"
      {...props}
      onPointerDown={(event) => {
        if (event.button !== 0 || event.isPrimary === false) return
        press.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
        }
        if (event.pointerType === "touch") event.preventDefault()
      }}
      onPointerUp={(event) => {
        const started = press.current
        press.current = null
        const rect = event.currentTarget.getBoundingClientRect()
        if (
          !started ||
          started.id !== event.pointerId ||
          event.button !== 0 ||
          Math.hypot(event.clientX - started.x, event.clientY - started.y) >=
            8 ||
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          return
        // 画布手势后浏览器可能省略合成 click；抬手执行，避免漏操作或重复点击。
        event.preventDefault()
        onClick?.(event)
      }}
      onPointerCancel={() => {
        press.current = null
      }}
      onClick={(event) => {
        // 键盘、无障碍和程序点击没有指针抬手事件。
        if (event.detail === 0) onClick?.(event)
      }}
    />
  )
}

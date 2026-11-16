"use client"

import { useEffect, useRef } from "react"
import { createPortal } from "react-dom"

import { Button } from "@/components/ui/button"

export interface EgoContextMenuState {
  tabId: string
  x: number
  y: number
  linkUrl: string | null
  selection: string
  editable: boolean
}

export function EgoContextMenu({
  menu,
  portal,
  onClose,
  onAction,
  onCopy,
  copyFallback = null,
}: {
  menu: EgoContextMenuState
  portal: HTMLElement
  onClose: () => void
  onAction: (action: Record<string, unknown>, tabId: string) => void
  onCopy: (text: string) => void
  copyFallback?: string | null
}) {
  const element = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    element.current?.querySelector<HTMLButtonElement>("button")?.focus({
      preventScroll: true,
    })
    const dismiss = (event: PointerEvent) => {
      if (!element.current?.contains(event.target as Node)) onClose()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopImmediatePropagation()
      const release = (released: KeyboardEvent) => {
        if (released.key !== "Escape") return
        released.preventDefault()
        released.stopImmediatePropagation()
        document.removeEventListener("keyup", release, true)
        clearTimeout(expiry)
      }
      const expiry = setTimeout(
        () => document.removeEventListener("keyup", release, true),
        1000
      )
      document.addEventListener("keyup", release, true)
      onClose()
      // 只恢复当前 Web 文档内的输入焦点，不调用执行端窗口激活。
      previous?.focus({ preventScroll: true })
    }
    document.addEventListener("pointerdown", dismiss, true)
    document.addEventListener("keydown", escape, true)
    return () => {
      document.removeEventListener("pointerdown", dismiss, true)
      document.removeEventListener("keydown", escape, true)
    }
  }, [onClose])

  const act = (action: Record<string, unknown>) => {
    onAction(action, menu.tabId)
    onClose()
  }
  const itemClass = "h-10 justify-start rounded-lg px-2 text-xs sm:h-8"

  return createPortal(
    <div
      ref={element}
      role="menu"
      aria-label="Ego 页面右键菜单"
      className="fixed z-[110] flex max-h-[min(400px,90dvh)] w-56 flex-col overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(event) => {
        // 手动复制框属于本设备，必须保留手机系统自己的长按复制菜单。
        if (!(event.target instanceof HTMLTextAreaElement))
          event.preventDefault()
      }}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLTextAreaElement) return
        if (event.key === "Tab") {
          onClose()
          return
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
        event.preventDefault()
        const items = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            'button[role="menuitem"]'
          )
        )
        const current = items.indexOf(
          document.activeElement as HTMLButtonElement
        )
        const index =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (current +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  items.length) %
                items.length
        items[index]?.focus()
      }}
    >
      {menu.linkUrl && (
        <>
          <Button
            role="menuitem"
            variant="ghost"
            className={itemClass}
            onClick={() => act({ kind: "open", url: menu.linkUrl })}
          >
            在新标签页打开链接
          </Button>
          <Button
            role="menuitem"
            variant="ghost"
            className={itemClass}
            onClick={() => onCopy(menu.linkUrl!)}
          >
            复制链接地址
          </Button>
        </>
      )}
      {menu.selection && (
        <Button
          role="menuitem"
          variant="ghost"
          className={itemClass}
          onClick={() => onCopy(menu.selection)}
        >
          复制所选文字
        </Button>
      )}
      {copyFallback && (
        <label className="px-2 py-1 text-xs">
          自动复制被拒绝，请长按下方文字复制
          <textarea
            aria-label="手动复制文字"
            readOnly
            value={copyFallback}
            className="mt-1 max-h-24 w-full rounded border p-2 text-base select-text"
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      )}
      {(
        [
          ["back", "后退"],
          ["forward", "前进"],
          ["reload", "刷新"],
        ] as const
      ).map(([kind, label]) => (
        <Button
          key={kind}
          role="menuitem"
          variant="ghost"
          className={itemClass}
          onClick={() => act({ kind })}
        >
          {label}
        </Button>
      ))}
      <Button
        role="menuitem"
        variant="ghost"
        className={itemClass}
        onClick={onClose}
      >
        关闭菜单
      </Button>
    </div>,
    portal
  )
}

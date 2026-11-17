import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { EgoContextMenu, type EgoContextMenuState } from "./ego-context-menu"

const menu: EgoContextMenuState = {
  tabId: "original-page",
  x: 20,
  y: 30,
  linkUrl: "https://example.com/",
  selection: "所选文字",
  editable: false,
}

describe("Ego Web 右键菜单", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("菜单在手机软键盘和横屏可见区域内定位，查看不发送远端动作", () => {
    const viewport = Object.assign(new EventTarget(), {
      width: 320,
      height: 260,
      offsetTop: 20,
      offsetLeft: 0,
    })
    vi.stubGlobal("visualViewport", viewport)
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 300,
      top: 700,
      width: 224,
      height: 220,
      right: 524,
      bottom: 920,
      x: 300,
      y: 700,
      toJSON: () => ({}),
    })
    const action = vi.fn()
    render(
      <EgoContextMenu
        menu={{ ...menu, x: 300, y: 700 }}
        portal={document.body}
        onClose={vi.fn()}
        onAction={action}
        onCopy={vi.fn()}
      />
    )
    const element = screen.getByRole("menu")
    expect(element).toHaveStyle({
      left: "88px",
      top: "52px",
      maxHeight: "244px",
    })
    act(() => {
      viewport.height = 180
      viewport.dispatchEvent(new Event("resize"))
    })
    expect(element).toHaveStyle({ top: "28px", maxHeight: "164px" })
    expect(action).not.toHaveBeenCalled()
  })
  it("手动复制框保留本设备原生长按菜单和键盘选区操作", () => {
    render(
      <EgoContextMenu
        menu={menu}
        portal={document.body}
        onClose={vi.fn()}
        onAction={vi.fn()}
        onCopy={vi.fn()}
        copyFallback="https://example.com/fallback"
      />
    )
    const field = screen.getByRole("textbox", { name: "手动复制文字" })
    expect(field).toHaveValue("https://example.com/fallback")
    expect(fireEvent.contextMenu(field)).toBe(true)
    expect(fireEvent.keyDown(field, { key: "Home" })).toBe(true)
    expect(fireEvent.contextMenu(screen.getByRole("menu"))).toBe(false)
  })
  it("键盘移动与关闭只影响本地菜单，不发送远端按键", () => {
    const close = vi.fn()
    const action = vi.fn()
    render(
      <EgoContextMenu
        menu={menu}
        portal={document.body}
        onClose={close}
        onAction={action}
        onCopy={vi.fn()}
      />
    )
    expect(
      screen.getByRole("menuitem", { name: "在新标签页打开链接" })
    ).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" })
    expect(screen.getByRole("menuitem", { name: "复制链接地址" })).toHaveFocus()
    fireEvent.keyDown(document, { key: "Escape" })
    const keyRelease = new KeyboardEvent("keyup", {
      key: "Escape",
      cancelable: true,
      bubbles: true,
    })
    document.dispatchEvent(keyRelease)
    expect(keyRelease.defaultPrevented).toBe(true)
    expect(close).toHaveBeenCalledOnce()
    expect(action).not.toHaveBeenCalled()
  })

  it("复制交付当前设备，导航仍带产生菜单的原页面标识", () => {
    const action = vi.fn()
    const copy = vi.fn()
    render(
      <EgoContextMenu
        menu={menu}
        portal={document.body}
        onClose={vi.fn()}
        onAction={action}
        onCopy={copy}
      />
    )
    fireEvent.click(screen.getByRole("menuitem", { name: "复制所选文字" }))
    expect(copy).toHaveBeenCalledWith("所选文字")
    expect(action).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("menuitem", { name: "刷新" }))
    expect(action).toHaveBeenCalledWith({ kind: "reload" }, "original-page")
  })
})

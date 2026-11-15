import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ConversationPaneSwitcher } from "./conversation-pane-switcher"
import { resetTabStore, useTabStore } from "@/stores/tab-store"
import {
  initialConversationPanes,
  normalizeConversationPanes,
} from "@/lib/conversation-panes"
import { StaticConnectionStoreProvider } from "@/contexts/acp-connections-context"
import type { ConnectionStoreApi } from "@/contexts/acp-connections-context"
import { makePaneTestConnection } from "@/lib/conversation-pane-test-helpers"
import {
  CONVERSATION_PANE_SWITCHER_POSITION_KEY,
  DEFAULT_CONVERSATION_PANE_SWITCHER_POSITION,
} from "@/lib/conversation-pane-switcher-position"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
}))

const messages = {
  ConversationPanes: {
    label: "Pane",
    create: "新建 Pane",
    rename: "重命名",
    remove: "移除 Pane",
    move: "移动到 Pane",
    name: "Pane 名称",
    save: "保存",
    cancel: "取消",
    resetPosition: "重置灵动岛位置",
    dragHint: "拖动可调整灵动岛位置",
    status: {
      running: "进行中",
      runningMany: "{count} 个进行中",
      waiting: "待处理",
      waitingMany: "{count} 个待处理",
      completed: "已完成",
      completedMany: "{count} 个已完成",
      error: "出错",
      errorMany: "{count} 个出错",
    },
    removeDraftTitle: "移除包含未发送内容的 Pane？",
    removeDraftDescription: "历史保留，任务继续。",
  },
}

function mount(mobile = false) {
  return render(
    <NextIntlClientProvider locale="zh-CN" messages={messages}>
      <ConversationPaneSwitcher mobile={mobile} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  localStorage.clear()
  resetTabStore()
  useTabStore.setState({ paneState: initialConversationPanes() })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("浮动 Pane 切换栏", () => {
  it("收起显示当前短名，靠近展开且离开后延迟收起", () => {
    vi.useFakeTimers()
    const { container } = mount()
    expect(
      screen.getByRole("button", { name: "Pane: Pane 1" })
    ).toHaveAttribute("aria-expanded", "false")
    const host = container.querySelector("[data-conversation-pane-switcher]")!
    fireEvent.pointerEnter(host)
    expect(screen.getByRole("tab", { name: "Pane 1" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    fireEvent.pointerLeave(host)
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(
      screen
        .getByRole("tab", { name: "Pane 1" })
        .closest("[data-pane-expanded]")
    ).toHaveAttribute("aria-hidden", "false")
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(
      screen.getByRole("button", { name: "Pane: Pane 1" })
    ).toHaveAttribute("aria-expanded", "false")
  })

  it("点击和键盘可展开、创建并切换 Pane", () => {
    mount()
    fireEvent.click(screen.getByRole("button", { name: "Pane: Pane 1" }))
    fireEvent.click(screen.getByRole("button", { name: "新建 Pane" }))
    expect(screen.getByRole("tab", { name: "Pane 2" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    fireEvent.keyDown(screen.getByRole("tab", { name: "Pane 2" }), {
      key: "ArrowLeft",
    })
    expect(screen.getByRole("tab", { name: "Pane 1" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    fireEvent.keyDown(screen.getByRole("tab", { name: "Pane 1" }), {
      key: "End",
    })
    expect(screen.getByRole("tab", { name: "Pane 2" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
  })

  it("快速返回操作区取消收起，内容节点在开合期间保持稳定", () => {
    vi.useFakeTimers()
    const { container } = mount()
    const host = container.querySelector("[data-conversation-pane-switcher]")!
    const trigger = screen.getByRole("button", { name: "Pane: Pane 1" })
    const content = container.querySelector("[data-pane-expanded]")!
    expect(content).toHaveAttribute("inert")
    fireEvent.pointerEnter(host)
    expect(content).not.toHaveAttribute("inert")
    fireEvent.pointerLeave(host)
    act(() => vi.advanceTimersByTime(200))
    fireEvent.pointerEnter(host)
    act(() => vi.advanceTimersByTime(400))
    expect(screen.getByRole("tab", { name: "Pane 1" })).toBeInTheDocument()
    fireEvent.pointerLeave(host)
    act(() => vi.advanceTimersByTime(300))
    expect(screen.getByRole("button", { name: "Pane: Pane 1" })).toBe(trigger)
    expect(container.querySelector("[data-pane-expanded]")).toBe(content)
    expect(content).toHaveAttribute("inert")
  })

  it("从 Pane 名称右键菜单改名", () => {
    mount()
    fireEvent.click(screen.getByRole("button", { name: "Pane: Pane 1" }))
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Pane 1" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Pane 名称" }), {
      target: { value: "研究" },
    })
    fireEvent.click(screen.getByRole("button", { name: "保存" }))
    expect(useTabStore.getState().paneState!.panes[0].name).toBe("研究")
  })

  it("拖动后保存归一化位置，右键菜单可恢复默认位置", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000)
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800)
    const { container } = mount()
    const surface = container.querySelector<HTMLElement>("[data-pane-surface]")!
    const anchor = container.querySelector<HTMLElement>("[data-pane-anchor]")!
    fireEvent.click(screen.getByRole("button", { name: "Pane: Pane 1" }))

    const pointerEvent = (type: string, clientX: number, clientY: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        button: 0,
        clientX,
        clientY,
      })
      Object.defineProperty(event, "pointerId", { value: 1 })
      return event
    }
    fireEvent(surface, pointerEvent("pointerdown", 100, 100))
    fireEvent(window, pointerEvent("pointermove", 112, 124))
    expect(surface).toHaveAttribute("data-dragging", "true")
    expect(
      screen.getByRole("button", { name: "Pane: Pane 1" })
    ).toHaveAttribute("aria-expanded", "false")
    expect(anchor.style.transform).not.toBe("translate3d(0px, 2px, 0px)")
    fireEvent(window, pointerEvent("pointerup", 112, 124))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const stored = JSON.parse(
      localStorage.getItem(CONVERSATION_PANE_SWITCHER_POSITION_KEY)!
    )
    expect(stored.x).toBeGreaterThan(0)
    expect(stored.y).toBeGreaterThan(0)
    expect(surface).not.toHaveAttribute("data-dragging")

    fireEvent.click(screen.getByRole("button", { name: "Pane: Pane 1" }))
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Pane 1" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "重置灵动岛位置" }))
    expect(
      JSON.parse(localStorage.getItem(CONVERSATION_PANE_SWITCHER_POSITION_KEY)!)
    ).toEqual(DEFAULT_CONVERSATION_PANE_SWITCHER_POSITION)
  })

  it("键盘聚焦展开后焦点进入当前 Pane，Escape 收起并回到胶囊", () => {
    mount()
    act(() => screen.getByRole("button", { name: "Pane: Pane 1" }).focus())
    expect(screen.getByRole("tab", { name: "Pane 1" })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole("tab", { name: "Pane 1" }), {
      key: "Escape",
    })
    expect(screen.getByRole("button", { name: "Pane: Pane 1" })).toHaveFocus()
    expect(screen.queryByRole("tab", { name: "Pane 1" })).toBeNull()
  })

  it("手机点击切换和创建 Pane 后收起，离开触摸区域不会自动收起", () => {
    vi.useFakeTimers()
    const { container } = mount(true)
    fireEvent.click(screen.getByRole("button", { name: "Pane: Pane 1" }))
    fireEvent.pointerLeave(
      container.querySelector("[data-conversation-pane-switcher]")!
    )
    act(() => vi.advanceTimersByTime(500))
    expect(screen.getByRole("tab", { name: "Pane 1" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    fireEvent.click(screen.getByRole("button", { name: "新建 Pane" }))
    expect(
      screen.getByRole("button", { name: "Pane: Pane 2" })
    ).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(screen.getByRole("button", { name: "Pane: Pane 2" }))
    fireEvent.click(screen.getByRole("tab", { name: "Pane 1" }))
    expect(useTabStore.getState().paneState!.activePaneId).toBe("pane-main")
    expect(
      screen.getByRole("button", { name: "Pane: Pane 1" })
    ).toHaveAttribute("aria-expanded", "false")
  })

  it("手机通过可见菜单重命名 Pane，不依赖右键", () => {
    mount(true)
    fireEvent.click(screen.getByRole("button", { name: "Pane: Pane 1" }))
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Pane 1: 重命名 / 移除 Pane" }),
      { key: "Enter" }
    )
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Pane 名称" }), {
      target: { value: "手机工作区" },
    })
    fireEvent.click(screen.getByRole("button", { name: "保存" }))
    expect(useTabStore.getState().paneState!.panes[0].name).toBe("手机工作区")
    expect(
      screen.getByRole("button", { name: "Pane: 手机工作区" })
    ).toHaveAttribute("aria-expanded", "false")
  })

  it("手机移除当前空 Pane 后解除菜单锁定并收起", () => {
    useTabStore.getState().createPane()
    mount(true)
    fireEvent.click(screen.getByRole("button", { name: "Pane: Pane 2" }))
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Pane 2: 重命名 / 移除 Pane" }),
      { key: "Enter" }
    )
    fireEvent.click(screen.getByRole("menuitem", { name: "移除 Pane" }))
    expect(useTabStore.getState().paneState!.panes).toHaveLength(1)
    expect(
      screen.getByRole("button", { name: "Pane: Pane 1" })
    ).toHaveAttribute("aria-expanded", "false")
  })

  it("实时状态只更新摘要，不自动展开或抢占操作", () => {
    let connection = makePaneTestConnection({ status: "prompting" })
    const listeners = new Set<() => void>()
    const store = {
      getConnection: () => connection,
      getConnectPending: () => undefined,
      getConnectError: () => undefined,
      getActiveKey: () => null,
      subscribeActiveKey: () => () => {},
      subscribeKey: (_key: string, listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    } as ConnectionStoreApi
    useTabStore.setState({
      rawTabs: [
        {
          id: "conv-1",
          kind: "conversation",
          folderId: 1,
          conversationId: 1,
          agentType: "codex",
          title: "任务",
          isPinned: false,
        },
      ],
    })
    useTabStore.setState({
      tabs: useTabStore.getState().rawTabs,
      paneState: normalizeConversationPanes(
        initialConversationPanes(),
        useTabStore.getState().rawTabs
      ),
    })
    render(
      <NextIntlClientProvider locale="zh-CN" messages={messages}>
        <StaticConnectionStoreProvider store={store}>
          <ConversationPaneSwitcher />
        </StaticConnectionStoreProvider>
      </NextIntlClientProvider>
    )
    expect(screen.getByText("进行中")).toBeInTheDocument()
    act(() => {
      connection = {
        ...connection,
        pendingPermission: {
          request_id: "permission-1",
          tool_call: {},
          options: [],
        },
      }
      listeners.forEach((listener) => listener())
    })
    expect(screen.getByText("待处理")).toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "Pane 1" })).toBeNull()
  })

  it("触屏展开后主动滚到当前 Pane，包含它的操作按钮", () => {
    useTabStore.getState().createPane()
    const { container } = mount(true)
    const rail = container.querySelector<HTMLElement>("[data-pane-expanded]")!
    const selected = rail.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"]'
    )!
    vi.spyOn(rail, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 200, 50)
    )
    vi.spyOn(selected.parentElement!, "getBoundingClientRect").mockReturnValue(
      new DOMRect(300, 0, 204, 44)
    )
    rail.scrollBy = vi.fn()
    fireEvent.click(screen.getByRole("button", { name: "Pane: Pane 2" }))
    expect(rail.scrollBy).toHaveBeenCalledWith({
      left: 304,
      behavior: "instant",
    })
  })
})

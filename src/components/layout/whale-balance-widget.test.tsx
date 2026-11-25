import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

// jsdom 默认未实现 PointerEvent，测试中轻量补齐坐标与 pointerId 字段。
beforeAll(() => {
  if (typeof globalThis.PointerEvent === "undefined") {
    class MockPointerEvent extends MouseEvent {
      pointerId: number
      pointerType: string
      constructor(type: string, params: PointerEventInit = {}) {
        super(type, params)
        this.pointerId = params.pointerId ?? 0
        this.pointerType = params.pointerType ?? "mouse"
      }
    }
    vi.stubGlobal("PointerEvent", MockPointerEvent)
  }
})

const mobileState = vi.hoisted(() => ({ current: false }))
const subscribedHandler = vi.hoisted(() => ({
  fn: null as ((snap: unknown) => void) | null,
}))

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mobileState.current,
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({
    call: vi.fn(),
    subscribe: vi.fn(),
    isDesktop: () => true,
  }),
}))

vi.mock("@/lib/api", () => ({
  getWhaleBalancePresentation: vi.fn(async () => ({
    showBalance: true,
    showApiUsed: true,
    showObservedToday: false,
    showTokenCost: false,
    widgetSize: 44,
  })),
  getWhaleBalanceState: vi.fn(),
  refreshWhaleBalance: vi.fn(),
  openSettingsWindow: vi.fn(async () => {}),
  subscribeWhaleBalanceUpdated: vi.fn(async (cb: (snap: unknown) => void) => {
    subscribedHandler.fn = cb
    return () => {
      subscribedHandler.fn = null
    }
  }),
  subscribeWhaleBalancePresentation: vi.fn(async () => () => {}),
}))

import {
  getWhaleBalancePresentation,
  getWhaleBalanceState,
  openSettingsWindow,
  refreshWhaleBalance,
} from "@/lib/api"
import zhCNMessages from "@/i18n/messages/zh-CN.json"
import { WhaleBalanceWidget } from "./whale-balance-widget"

function renderWidget() {
  return render(
    <NextIntlClientProvider locale="zh-CN" messages={zhCNMessages}>
      <WhaleBalanceWidget />
    </NextIntlClientProvider>
  )
}

describe("WhaleBalanceWidget", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mobileState.current = false
    subscribedHandler.fn = null
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("renders nothing when disabled", async () => {
    vi.mocked(getWhaleBalanceState).mockResolvedValueOnce({
      configured: false,
      enabled: false,
      accountName: "lk888",
      balance: null,
      used: null,
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastError: null,
      stale: false,
      refreshing: false,
      accountGeneration: 1,
    })

    renderWidget()
    await waitFor(() => expect(getWhaleBalanceState).toHaveBeenCalled())
    expect(screen.queryByTestId("whale-balance-widget")).not.toBeInTheDocument()
  })

  it("expands on desktop by default, distinguishes em-dash from 0.00, and retains last success on error", async () => {
    vi.mocked(getWhaleBalanceState).mockResolvedValueOnce({
      configured: true,
      enabled: true,
      accountName: "lk888",
      balance: null,
      used: null,
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastError: null,
      stale: false,
      refreshing: false,
      accountGeneration: 1,
    })

    renderWidget()

    // 首次未成功获取时显示「—」。
    const summary = await screen.findByTestId("whale-balance-summary")
    expect(summary).toHaveTextContent("—")
    expect(screen.getByText("lk888 余额")).toBeInTheDocument()

    // 推送真实零余额，严格格式化为 0.00，不带「算力」或总量。
    act(() => {
      subscribedHandler.fn?.({
        configured: true,
        enabled: true,
        accountName: "lk888",
        balance: 0,
        used: 12.5,
        lastSuccessAt: "2026-11-24T12:00:00Z",
        lastAttemptAt: "2026-11-24T12:00:00Z",
        lastError: null,
        stale: false,
        refreshing: false,
        accountGeneration: 1,
      })
    })
    expect(summary).toHaveTextContent("0.00")
    expect(screen.getByTestId("whale-balance-hint")).toHaveTextContent(
      "接口已用 12.50"
    )
    expect(summary.textContent).not.toContain("算力")

    // 查询失败时沿用上次读数并标明更新时间。
    act(() => {
      subscribedHandler.fn?.({
        configured: true,
        enabled: true,
        accountName: "lk888",
        balance: 0,
        used: 12.5,
        lastSuccessAt: "2026-11-24T12:00:00Z",
        lastAttemptAt: "2026-11-24T12:01:00Z",
        lastError: "HTTP 500",
        stale: true,
        refreshing: false,
        accountGeneration: 1,
      })
    })
    expect(summary).toHaveTextContent("0.00")
    // 失败时气泡改成提示行，数值仍在金额行保留。
    expect(screen.getByTestId("whale-balance-stale")).toBeInTheDocument()
  })

  it("collapses by default on mobile and expands on tap", async () => {
    mobileState.current = true
    vi.mocked(getWhaleBalanceState).mockResolvedValueOnce({
      configured: true,
      enabled: true,
      accountName: "lk888",
      balance: 88.5,
      used: 11.2,
      lastSuccessAt: "2026-11-24T12:00:00Z",
      lastAttemptAt: "2026-11-24T12:00:00Z",
      lastError: null,
      stale: false,
      refreshing: false,
      accountGeneration: 1,
    })

    renderWidget()

    const toggle = await screen.findByRole("button", {
      name: "展开或收起小鲸鱼余额气泡",
    })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByTestId("whale-balance-bubble")).not.toBeInTheDocument()

    // 轻点展开气泡。
    fireEvent.click(toggle)

    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByTestId("whale-balance-summary")).toHaveTextContent(
      "88.50"
    )
  })

  it("supports dragging without toggling and triggers manual refresh & settings", async () => {
    vi.mocked(getWhaleBalanceState).mockResolvedValueOnce({
      configured: true,
      enabled: true,
      accountName: "test-acct",
      balance: 10.5,
      used: 2.25,
      lastSuccessAt: "2026-11-24T12:00:00Z",
      lastAttemptAt: "2026-11-24T12:00:00Z",
      lastError: null,
      stale: false,
      refreshing: false,
      accountGeneration: 1,
    })
    vi.mocked(refreshWhaleBalance).mockResolvedValueOnce({
      configured: true,
      enabled: true,
      accountName: "test-acct",
      balance: 9.5,
      used: 3.25,
      lastSuccessAt: "2026-11-24T12:01:00Z",
      lastAttemptAt: "2026-11-24T12:01:00Z",
      lastError: null,
      stale: false,
      refreshing: false,
      accountGeneration: 1,
    })

    renderWidget()

    const toggle = await screen.findByRole("button", {
      name: "展开或收起小鲸鱼余额气泡",
    })
    expect(toggle).toHaveAttribute("aria-expanded", "true")

    const root = screen.getByTestId("whale-balance-widget")
    const bounds = root.parentElement!
    vi.spyOn(bounds, "clientWidth", "get").mockReturnValue(1024)
    vi.spyOn(bounds, "clientHeight", "get").mockReturnValue(736)

    // 拖到中央再拖回边角，松手后要重新保存为锚点。
    fireEvent.pointerDown(toggle, { pointerId: 1, clientX: 900, clientY: 600 })
    fireEvent.pointerMove(toggle, { pointerId: 1, clientX: 500, clientY: 350 })
    fireEvent.pointerUp(toggle, { pointerId: 1, clientX: 500, clientY: 350 })
    expect(root.style.right).toBe("")
    expect(root.style.bottom).toBe("")

    // 拖拽超过阈值后即使触发紧随其后的 click 也不切换展开状态。
    fireEvent.pointerDown(toggle, { pointerId: 2, clientX: 500, clientY: 350 })
    fireEvent.pointerMove(toggle, { pointerId: 2, clientX: 860, clientY: 540 })
    fireEvent.pointerUp(toggle, { pointerId: 2, clientX: 860, clientY: 540 })
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(root).toHaveStyle({ right: "0px", bottom: "0px" })
    expect(window.localStorage.getItem("codeg-whale-coord-v2")).toBe(
      JSON.stringify({ x: null, y: null })
    )

    fireEvent.click(screen.getByRole("button", { name: "小鲸鱼菜单" }))
    fireEvent.click(screen.getByRole("button", { name: "刷新" }))
    await waitFor(() => expect(refreshWhaleBalance).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId("whale-balance-summary")).toHaveTextContent(
      "9.50"
    )

    fireEvent.click(screen.getByRole("button", { name: "完整设置" }))
    expect(openSettingsWindow).toHaveBeenCalledWith("general")
  })

  it.each([false, true])(
    "keeps the right and bottom edges when restoring the widget (saved=%s)",
    async (saved) => {
      if (saved) {
        window.localStorage.setItem(
          "codeg-whale-coord-v1",
          JSON.stringify({
            x: window.innerWidth - 56,
            y: window.innerHeight - 88,
          })
        )
      }
      vi.mocked(getWhaleBalancePresentation).mockResolvedValueOnce({
        showBalance: true,
        showApiUsed: true,
        showObservedToday: false,
        showTokenCost: false,
        widgetSize: 32,
      })
      vi.mocked(getWhaleBalanceState).mockResolvedValueOnce({
        configured: true,
        enabled: true,
        accountName: "test-acct",
        balance: 20,
        used: null,
        lastSuccessAt: null,
        lastAttemptAt: null,
        lastError: null,
        stale: false,
        refreshing: false,
        accountGeneration: 1,
      })

      renderWidget()

      const root = await screen.findByTestId("whale-balance-widget")
      expect(root).toHaveStyle({ right: "0px", bottom: "0px" })
      expect(root.parentElement).toHaveClass(
        "bottom-[calc(2rem+env(safe-area-inset-bottom))]"
      )
      fireEvent.click(screen.getByRole("button", { name: "小鲸鱼菜单" }))
      const oldWidth = Number.parseFloat(root.style.width)
      fireEvent.change(screen.getByRole("slider", { name: "挂件大小" }), {
        target: { value: "72" },
      })
      expect(Number.parseFloat(root.style.width)).toBeGreaterThan(oldWidth)
      expect(root).toHaveStyle({ right: "0px", bottom: "0px" })
    }
  )

  it("honours the saved presentation instead of always showing balance and used", async () => {
    // 关掉「接口已用」、打开「今日观测」，气泡应围绕配置重建。
    vi.mocked(getWhaleBalancePresentation).mockResolvedValueOnce({
      showBalance: true,
      showApiUsed: false,
      showObservedToday: true,
      showTokenCost: false,
      widgetSize: 72,
    })
    vi.mocked(getWhaleBalanceState).mockResolvedValueOnce({
      configured: true,
      enabled: true,
      accountName: "lk888",
      balance: 20,
      used: 5,
      observedToday: 1.5,
      lastSuccessAt: "2026-11-24T12:00:00Z",
      lastAttemptAt: "2026-11-24T12:00:00Z",
      lastError: null,
      stale: false,
      refreshing: false,
      accountGeneration: 1,
    })

    renderWidget()

    const summary = await screen.findByTestId("whale-balance-summary")
    const hint = await screen.findByTestId("whale-balance-hint")
    await waitFor(() => expect(hint).toHaveTextContent("今日观测 1.50"))
    expect(summary).toHaveTextContent("20.00")
    // 接口已用被关掉，不应再出现在气泡里。
    expect(hint.textContent).not.toContain("接口已用")

    fireEvent.click(screen.getByRole("button", { name: "小鲸鱼菜单" }))
    expect(screen.getByRole("slider", { name: "挂件大小" })).toHaveValue("72")
  })

  it("shows every enabled balance detail on its own readable line", async () => {
    vi.mocked(getWhaleBalancePresentation).mockResolvedValueOnce({
      showBalance: true,
      showApiUsed: true,
      showObservedToday: true,
      showTokenCost: true,
      widgetSize: 52,
    })
    vi.mocked(getWhaleBalanceState).mockResolvedValueOnce({
      configured: true,
      enabled: true,
      accountName: "lk888",
      balance: 703.13,
      used: 421.15,
      observedToday: 28.7,
      estimatedCostToday: 8.53,
      currency: "CNY",
      lastSuccessAt: "2026-11-24T12:00:00Z",
      lastAttemptAt: "2026-11-24T12:00:00Z",
      lastError: null,
      stale: false,
      refreshing: false,
      accountGeneration: 1,
    })

    renderWidget()

    const details = await screen.findByTestId("whale-balance-details")
    expect(details.children).toHaveLength(3)
    expect(details).toHaveTextContent("接口已用 421.15")
    expect(details).toHaveTextContent("今日观测 28.70")
    expect(details).toHaveTextContent("今日费用 CNY 8.53")
    expect(details).not.toHaveStyle({ color: "rgb(159, 176, 217)" })
    for (const row of Array.from(details.children)) {
      expect(row).not.toHaveStyle({ textOverflow: "ellipsis" })
      expect(row).not.toHaveStyle({ overflow: "hidden" })
    }
  })

  it("automatically refreshes every 30 seconds and clears the interval", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    vi.mocked(getWhaleBalanceState).mockResolvedValueOnce({
      configured: true,
      enabled: true,
      accountName: "lk888",
      balance: 1,
      used: null,
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastError: null,
      stale: false,
      refreshing: false,
      accountGeneration: 1,
    })
    vi.mocked(refreshWhaleBalance).mockResolvedValue({
      configured: true,
      enabled: true,
      accountName: "lk888",
      balance: 2,
      used: null,
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastError: null,
      stale: false,
      refreshing: false,
      accountGeneration: 1,
    })

    const { unmount } = renderWidget()
    const summary = await screen.findByTestId("whale-balance-summary")
    expect(summary).toHaveTextContent("1.00")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999)
    })
    expect(refreshWhaleBalance).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(refreshWhaleBalance).toHaveBeenCalledTimes(1)
    expect(summary).toHaveTextContent("2.00")

    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(refreshWhaleBalance).toHaveBeenCalledTimes(1)
  })
})

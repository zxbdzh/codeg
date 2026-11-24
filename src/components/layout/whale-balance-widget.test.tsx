import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

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
  getWhaleBalanceState: vi.fn(),
  refreshWhaleBalance: vi.fn(),
  openSettingsWindow: vi.fn(async () => {}),
  subscribeWhaleBalanceUpdated: vi.fn(async (cb: (snap: unknown) => void) => {
    subscribedHandler.fn = cb
    return () => {
      subscribedHandler.fn = null
    }
  }),
}))

import {
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
    expect(summary).toHaveTextContent("0.00 · 已用 12.50")
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
    expect(summary).toHaveTextContent("0.00 · 已用 12.50")
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
      "88.50 · 已用 11.20"
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

    // 拖拽超过阈值后即使触发紧随其后的 click 也不切换展开状态。
    fireEvent.pointerDown(toggle, { pointerId: 2, clientX: 500, clientY: 100 })
    fireEvent.pointerMove(toggle, { pointerId: 2, clientX: 460, clientY: 140 })
    fireEvent.pointerUp(toggle, { pointerId: 2, clientX: 460, clientY: 140 })
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")

    fireEvent.click(screen.getByRole("button", { name: "立即刷新余额" }))
    await waitFor(() => expect(refreshWhaleBalance).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId("whale-balance-summary")).toHaveTextContent(
      "9.50 · 已用 3.25"
    )

    fireEvent.click(screen.getByRole("button", { name: "打开余额设置" }))
    expect(openSettingsWindow).toHaveBeenCalledWith("general")
  })
})

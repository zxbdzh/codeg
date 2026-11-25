import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  getWhaleBalancePresentation: vi.fn(async () => ({
    showBalance: true,
    showApiUsed: true,
    showObservedToday: false,
    showTokenCost: false,
    widgetSize: 44,
  })),
  getWhaleBalanceSettings: vi.fn(),
  reconcileWhaleBalance: vi.fn(),
  saveWhaleBalancePresentation: vi.fn(async (input) => input),
  updateWhaleBalanceSettings: vi.fn(),
  testWhaleBalanceSettings: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import {
  getWhaleBalanceSettings,
  testWhaleBalanceSettings,
  updateWhaleBalanceSettings,
} from "@/lib/api"
import enMessages from "@/i18n/messages/en.json"
import { WhaleBalanceSettingsSection } from "./whale-balance-settings"

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WhaleBalanceSettingsSection />
    </NextIntlClientProvider>
  )
}

describe("WhaleBalanceSettingsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("shows masked key hint without prefilling secret and supports test & save", async () => {
    vi.mocked(getWhaleBalanceSettings).mockResolvedValueOnce({
      models: [
        {
          id: "default",
          accountName: "lk888",
          url: "https://api.example.com/v1/skills/balance",
          method: "GET",
          authHeader: "Bearer {key}",
          hasApiKey: true,
          apiKeyHint: "demo****9876",
          remainingPath: "balance",
          usedPath: "api_key_quota.used",
          totalPath: "",
          unitPath: "",
          scale: 1,
        },
      ],
      activeModelId: "default",
      peakPrice: null,
      offPeakPrice: null,
      currency: "CNY",
      totalPath: "",
      unitPath: "",
      enabled: true,
      accountName: "lk888",
      url: "https://api.example.com/v1/skills/balance",
      method: "GET",
      authHeader: "Bearer {key}",
      hasApiKey: true,
      apiKeyHint: "demo****9876",
      remainingPath: "balance",
      usedPath: "api_key_quota.used",
      scale: 1,
      pollIntervalSecs: 60,
    })

    vi.mocked(testWhaleBalanceSettings).mockResolvedValueOnce({
      ok: true,
      balance: 0,
      used: 12.5,
      error: null,
    })

    vi.mocked(updateWhaleBalanceSettings).mockResolvedValueOnce({
      enabled: true,
      accountName: "lk888",
      url: "https://api.example.com/v1/skills/balance",
      method: "GET",
      authHeader: "Bearer {key}",
      hasApiKey: true,
      apiKeyHint: "newk****1111",
      remainingPath: "balance",
      usedPath: "api_key_quota.used",
      scale: 1,
      pollIntervalSecs: 60,
    })

    renderSection()

    const keyInput = (await screen.findByLabelText(
      "API key"
    )) as HTMLInputElement
    // 后端已存密钥绝不回填到前端输入框，仅在 placeholder 中显示脱敏提示。
    expect(keyInput.value).toBe("")
    expect(keyInput.placeholder).toContain("demo****9876")

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }))
    await waitFor(() =>
      expect(
        screen.getByText("Connected: 0.00 · Used 12.50")
      ).toBeInTheDocument()
    )

    fireEvent.change(keyInput, { target: { value: "new-secret-key-1111" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(updateWhaleBalanceSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          accountName: "lk888",
          apiKey: "new-secret-key-1111",
          clearApiKey: false,
        })
      )
    )
    expect(keyInput.value).toBe("")
  })

  it("allows clearing a stored key explicitly", async () => {
    vi.mocked(getWhaleBalanceSettings).mockResolvedValueOnce({
      models: [
        {
          id: "default",
          accountName: "lk888",
          url: "https://api.example.com/v1/skills/balance",
          method: "GET",
          authHeader: "Bearer {key}",
          hasApiKey: true,
          apiKeyHint: "demo****9876",
          remainingPath: "balance",
          usedPath: "api_key_quota.used",
          totalPath: "",
          unitPath: "",
          scale: 1,
        },
      ],
      activeModelId: "default",
      peakPrice: null,
      offPeakPrice: null,
      currency: "CNY",
      totalPath: "",
      unitPath: "",
      enabled: true,
      accountName: "lk888",
      url: "https://api.example.com/v1/skills/balance",
      method: "GET",
      authHeader: "Bearer {key}",
      hasApiKey: true,
      apiKeyHint: "demo****9876",
      remainingPath: "balance",
      usedPath: "api_key_quota.used",
      scale: 1,
      pollIntervalSecs: 60,
    })
    vi.mocked(updateWhaleBalanceSettings).mockResolvedValueOnce({
      enabled: true,
      accountName: "lk888",
      url: "https://api.example.com/v1/skills/balance",
      method: "GET",
      authHeader: "Bearer {key}",
      hasApiKey: false,
      apiKeyHint: null,
      remainingPath: "balance",
      usedPath: "api_key_quota.used",
      scale: 1,
      pollIntervalSecs: 60,
    })

    renderSection()

    fireEvent.click(await screen.findByRole("button", { name: "Clear key" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(updateWhaleBalanceSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: null,
          clearApiKey: true,
        })
      )
    )
  })

  it("persists display preferences as soon as a toggle changes", async () => {
    vi.mocked(getWhaleBalanceSettings).mockResolvedValueOnce({
      models: [
        {
          id: "default",
          accountName: "lk888",
          url: "https://api.example.com/v1/skills/balance",
          method: "GET",
          authHeader: "Bearer {key}",
          hasApiKey: false,
          apiKeyHint: null,
          remainingPath: "balance",
          usedPath: "api_key_quota.used",
          totalPath: "",
          unitPath: "",
          scale: 1,
        },
      ],
      activeModelId: "default",
      peakPrice: null,
      offPeakPrice: null,
      currency: "CNY",
      totalPath: "",
      unitPath: "",
      enabled: true,
      accountName: "lk888",
      url: "https://api.example.com/v1/skills/balance",
      method: "GET",
      authHeader: "Bearer {key}",
      hasApiKey: false,
      apiKeyHint: null,
      remainingPath: "balance",
      usedPath: "api_key_quota.used",
      scale: 1,
      pollIntervalSecs: 60,
    })

    const api = await import("@/lib/api")
    renderSection()

    fireEvent.click(
      await screen.findByRole("switch", { name: "Show observed spend today" })
    )

    await waitFor(() =>
      expect(api.saveWhaleBalancePresentation).toHaveBeenCalledWith(
        expect.objectContaining({ showObservedToday: true })
      )
    )
  })

  it("shows the peak window that the backend actually bills", async () => {
    vi.mocked(getWhaleBalanceSettings).mockResolvedValueOnce({
      models: [
        {
          id: "default",
          accountName: "lk888",
          url: "https://api.example.com/v1/skills/balance",
          method: "GET",
          authHeader: "Bearer {key}",
          hasApiKey: false,
          apiKeyHint: null,
          remainingPath: "balance",
          usedPath: "",
          totalPath: "",
          unitPath: "",
          scale: 1,
        },
      ],
      activeModelId: "default",
      peakPrice: null,
      offPeakPrice: null,
      currency: "CNY",
      totalPath: "",
      unitPath: "",
      enabled: true,
      accountName: "lk888",
      url: "https://api.example.com/v1/skills/balance",
      method: "GET",
      authHeader: "Bearer {key}",
      hasApiKey: false,
      apiKeyHint: null,
      remainingPath: "balance",
      usedPath: "",
      scale: 1,
      pollIntervalSecs: 60,
    })

    renderSection()

    // 文案必须与实际判定一致，否则用户会按错误时段估算费用。
    expect(
      await screen.findByText(/09:00–12:00 and 14:00–18:00/)
    ).toBeInTheDocument()
  })

  it("does not persist half-typed edits when only the switch is toggled", async () => {
    vi.mocked(getWhaleBalanceSettings).mockResolvedValueOnce({
      models: [
        {
          id: "default",
          accountName: "lk888",
          url: "https://saved.example.com/balance",
          method: "GET",
          authHeader: "Bearer {key}",
          hasApiKey: false,
          apiKeyHint: null,
          remainingPath: "balance",
          usedPath: "",
          totalPath: "",
          unitPath: "",
          scale: 1,
        },
      ],
      activeModelId: "default",
      peakPrice: null,
      offPeakPrice: null,
      currency: "CNY",
      totalPath: "",
      unitPath: "",
      enabled: false,
      accountName: "lk888",
      url: "https://saved.example.com/balance",
      method: "GET",
      authHeader: "Bearer {key}",
      hasApiKey: false,
      apiKeyHint: null,
      remainingPath: "balance",
      usedPath: "",
      scale: 1,
      pollIntervalSecs: 60,
    })
    vi.mocked(updateWhaleBalanceSettings).mockResolvedValueOnce({
      enabled: true,
      accountName: "lk888",
      url: "https://saved.example.com/balance",
      method: "GET",
      authHeader: "Bearer {key}",
      hasApiKey: false,
      apiKeyHint: null,
      remainingPath: "balance",
      usedPath: "",
      scale: 1,
      pollIntervalSecs: 60,
    })

    renderSection()

    const urlInput = (await screen.findByLabelText(
      "Balance endpoint"
    )) as HTMLInputElement
    fireEvent.change(urlInput, { target: { value: "https://draft.example" } })

    fireEvent.click(
      screen.getByRole("switch", { name: "Enable whale balance widget" })
    )

    // 开关只提交已保存的地址，未保存的草稿不会被一并落库。
    await waitFor(() =>
      expect(updateWhaleBalanceSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          url: "https://saved.example.com/balance",
        })
      )
    )
  })
})

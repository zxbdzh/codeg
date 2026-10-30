import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  getAiAssistantSettings: vi.fn(),
  updateAiAssistantSettings: vi.fn(),
  getAiAssistantAvailability: vi.fn(),
  testAiAssistantConnection: vi.fn(),
  listModelProviders: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import {
  getAiAssistantAvailability,
  getAiAssistantSettings,
  listModelProviders,
  testAiAssistantConnection,
  updateAiAssistantSettings,
} from "@/lib/api"
import { toast } from "sonner"
import enMessages from "@/i18n/messages/en.json"
import type { AiAssistantSettings, ModelProviderInfo } from "@/lib/types"

import { AiAssistantSettingsSection } from "./ai-assistant-settings"

const toastSuccess = vi.mocked(toast.success)
const toastError = vi.mocked(toast.error)

const mockGetSettings = vi.mocked(getAiAssistantSettings)
const mockUpdateSettings = vi.mocked(updateAiAssistantSettings)
const mockGetAvailability = vi.mocked(getAiAssistantAvailability)
const mockTestConnection = vi.mocked(testAiAssistantConnection)
const mockListProviders = vi.mocked(listModelProviders)

function settings(
  overrides: Partial<AiAssistantSettings> = {}
): AiAssistantSettings {
  return {
    providerId: null,
    protocol: null,
    keyHeader: null,
    tagModel: "",
    titleModel: "",
    titleSource: "codeg",
    titleMinIntervalSeconds: 30,
    contextTurns: 6,
    autoSuggestTags: false,
    ...overrides,
  }
}

function provider(id: number, name: string): ModelProviderInfo {
  return {
    id,
    name,
    api_url: "https://relay.test/v1",
    // 密钥只复用，设置页不展示也不收集明文，所以这里给个占位即可。
    api_key: "sk-secret",
    api_key_masked: "sk-…",
    agent_type: "claude_code",
    model: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }
}

function renderWithIntl() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AiAssistantSettingsSection />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  toastSuccess.mockClear()
  toastError.mockClear()
  mockGetSettings.mockReset()
  mockUpdateSettings.mockReset()
  mockGetAvailability.mockReset()
  mockTestConnection.mockReset()
  mockListProviders.mockReset()
  // 默认就有一条提供方可用：大多数用例关心的是它下面的设置项。
  mockListProviders.mockResolvedValue([provider(7, "My relay")])
  mockGetAvailability.mockResolvedValue("ready")
})

describe("AiAssistantSettingsSection", () => {
  it("loads the saved settings and the providers it can reuse", async () => {
    mockGetSettings.mockResolvedValue(
      settings({ providerId: 7, tagModel: "gpt-4o-mini" })
    )
    mockListProviders.mockResolvedValue([provider(7, "My relay")])

    renderWithIntl()

    // 已保存的值直接落到控件上，不需要再点一次保存。
    const tagModel = await screen.findByLabelText("Tag model")
    expect(tagModel).toHaveValue("gpt-4o-mini")

    // 标题模型留空表示跟标签模型同一个（后端 model_for 的回落语义）。
    expect(screen.getByLabelText("Title model")).toHaveValue("")
    expect(screen.getByText("Same as the tag model")).toBeVisible()

    // 上下文轮数与标题间隔取已存值，而不是写死默认值。
    expect(screen.getByLabelText("Context turns")).toHaveValue(6)
    expect(screen.getByLabelText("Title interval (seconds)")).toHaveValue(30)

    // 没有落过改动，保存是禁用的。
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  it("names the provider it reuses on the picker's trigger", async () => {
    mockGetSettings.mockResolvedValue(
      settings({ providerId: 7, tagModel: "m" })
    )
    mockListProviders.mockResolvedValue([provider(7, "My relay")])

    renderWithIntl()

    // 密钥只复用：设置页展示的是提供方的名字，不是它的地址或密钥。
    expect(await screen.findByText("My relay")).toBeVisible()
    expect(screen.queryByText("sk-secret")).toBeNull()
    expect(screen.queryByText("https://relay.test/v1")).toBeNull()
  })

  it("lets the user pick the protocol, and never offers Gemini", async () => {
    const user = userEvent.setup()
    mockGetSettings.mockResolvedValue(
      settings({ providerId: 7, protocol: "anthropic", tagModel: "m" })
    )
    mockListProviders.mockResolvedValue([provider(7, "My relay")])
    mockUpdateSettings.mockImplementation(async (s) => s)
    renderWithIntl()
    await screen.findByText("My relay")

    // 协议是设置页自己能改的：ModelProviderInfo 上根本没有协议字段，唯一的落点
    // 就是 AiAssistantSettings 自身（后端 settings.protocol() 未指定时按
    // OpenAI 兼容）。null 展示为 OpenAI 兼容，因为那就是后端的默认语义。
    const protocol = screen.getByRole("combobox", { name: "Protocol" })
    expect(protocol).toHaveTextContent("Anthropic")

    await user.click(protocol)
    await user.click(screen.getByRole("option", { name: "OpenAI-compatible" }))
    expect(protocol).toHaveTextContent("OpenAI-compatible")

    // Gemini 端不实现生成请求（后端判 unsupported_protocol），所以连可选项
    // 都不给：选中一条 gemini 提供方只意味着"不可用"，不是"能配"。
    await user.click(protocol)
    expect(screen.queryByRole("option", { name: "Gemini" })).toBeNull()
    await user.keyboard("{Escape}")

    // 改协议就是改 AiAssistantSettings 自身，不该被推回 provider 记录。
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ protocol: "openai" })
      )
    )
    expect(mockListProviders).not.toHaveBeenCalledWith(
      expect.objectContaining({ protocol: expect.anything() })
    )
  })

  it("lets the user override how the key is sent", async () => {
    const user = userEvent.setup()
    mockGetSettings.mockResolvedValue(
      settings({ providerId: 7, keyHeader: "x_api_key", tagModel: "m" })
    )
    mockListProviders.mockResolvedValue([provider(7, "My relay")])
    mockUpdateSettings.mockImplementation(async (s) => s)
    renderWithIntl()
    await screen.findByText("My relay")

    // claude_code 常用 Bearer 中转：覆盖密钥头是必需能力，不是展示值。
    const keyHeader = screen.getByRole("combobox", { name: "Key header" })
    expect(keyHeader).toHaveTextContent("x-api-key")

    await user.click(keyHeader)
    await user.click(
      screen.getByRole("option", { name: "Authorization: Bearer" })
    )
    expect(keyHeader).toHaveTextContent("Authorization: Bearer")

    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ keyHeader: "bearer" })
      )
    )
  })

  it("says a failed load failed, and offers a retry instead of spinning", async () => {
    mockGetSettings.mockRejectedValueOnce(new Error("boom"))
    renderWithIntl()

    // 加载失败不能退回 draft=null：那会让 `loading || !draft` 永远成立，
    // 页面就永远转圈，用户既看不到原因也没法重试。
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Could not load the AI assistant settings.")
    expect(screen.queryByRole("status")).toBeNull()

    // 重试要真的再拉一次，而不是把同一个坏结果再显示一遍。
    mockGetSettings.mockResolvedValue(settings({ providerId: 7 }))
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(await screen.findByText("My relay")).toBeVisible()
    expect(mockGetSettings).toHaveBeenCalledTimes(2)
  })

  it("saves what was edited, with the numbers clamped to the allowed range", async () => {
    const user = userEvent.setup()
    mockGetSettings.mockResolvedValue(settings({ providerId: 7 }))
    mockUpdateSettings.mockImplementation(async (s) => s)
    renderWithIntl()
    await screen.findByText("My relay")

    await user.clear(screen.getByLabelText("Tag model"))
    await user.type(screen.getByLabelText("Tag model"), "gpt-4o-mini")
    // 越界值在提交前夹回范围：后端也会夹，但先夹能让界面显示的就是会存下的值。
    await user.clear(screen.getByLabelText("Context turns"))
    await user.type(screen.getByLabelText("Context turns"), "999")
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: 7,
          tagModel: "gpt-4o-mini",
          contextTurns: 50,
          titleMinIntervalSeconds: 30,
          titleSource: "codeg",
          autoSuggestTags: false,
        })
      )
    )
  })

  it("keeps edits typed while a save is in flight and leaves them unsaved", async () => {
    const user = userEvent.setup()
    mockGetSettings.mockResolvedValue(
      settings({ providerId: 7, tagModel: "old" })
    )
    let finish: (value: AiAssistantSettings) => void = () => undefined
    mockUpdateSettings.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    renderWithIntl()
    const model = await screen.findByLabelText("Tag model")
    await user.clear(model)
    await user.type(model, "submitted")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await user.clear(model)
    await user.type(model, "newer draft")

    await act(async () => {
      finish(settings({ providerId: 7, tagModel: "submitted" }))
    })

    expect(model).toHaveValue("newer draft")
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
    expect(
      screen.getByRole("button", { name: "Test connection" })
    ).toBeDisabled()
  })

  it("only tests the connection once there is nothing unsaved", async () => {
    const user = userEvent.setup()
    mockGetSettings.mockResolvedValue(
      settings({ providerId: 7, tagModel: "gpt-4o-mini" })
    )
    mockTestConnection.mockResolvedValue(undefined)
    renderWithIntl()
    await screen.findByText("My relay")

    const testButton = screen.getByRole("button", { name: "Test connection" })
    // 一进来就是干净的，直接能测。
    expect(testButton).toBeEnabled()
    await user.click(testButton)
    await waitFor(() => expect(mockTestConnection).toHaveBeenCalledTimes(1))
    expect(toastSuccess).toHaveBeenCalled()

    // 改了但没保存：测试连接禁用，避免测一份还没生效的草稿。
    await user.type(screen.getByLabelText("Tag model"), "x")
    await waitFor(() => expect(testButton).toBeDisabled())
    await user.click(testButton)
    expect(mockTestConnection).toHaveBeenCalledTimes(1)

    // 保存之后又能测。
    mockUpdateSettings.mockImplementation(async (s) => s)
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(testButton).toBeEnabled())
  })

  it("says why a failed test failed, in the page's language", async () => {
    const user = userEvent.setup()
    mockGetSettings.mockResolvedValue(
      settings({ providerId: 7, tagModel: "gpt-4o-mini" })
    )
    mockTestConnection.mockRejectedValue({
      code: "authentication_failed",
      message: "401 from the provider",
      i18n_key: "aiAssistant.errorUnauthorized",
    })
    renderWithIntl()
    await screen.findByText("My relay")

    await user.click(screen.getByRole("button", { name: "Test connection" }))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "The connection test failed",
        expect.objectContaining({
          // 后端的 i18n_key 映射到本页文案，而不是把 key 或英文原句丢给用户。
          description: "The key was rejected (HTTP 401/403)",
        })
      )
    )
  })
})

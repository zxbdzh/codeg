import { describe, expect, it } from "vitest"

import { settingsNavItemsFor } from "./settings-shell"

describe("settingsNavItemsFor", () => {
  it("drops the Web service page in a browser session and nothing else", () => {
    const labels = settingsNavItemsFor("web").map((item) => item.labelKey)
    // There is no second server to configure from inside the one you are
    // already talking to.
    expect(labels).not.toContain("web_service")
    // The Browser page is mostly a desktop browser engine, but site rules,
    // what a server starting in a terminal does and the terminal's link menu
    // all still decide something here — and this page is the only place they
    // can be set, so the entry has to lead there.
    expect(labels).toContain("browser")
    expect(labels).toEqual(
      settingsNavItemsFor("tauri")
        .map((item) => item.labelKey)
        .filter((label) => label !== "web_service")
    )
  })

  it("keeps collaboration under General and the two Use pages together", () => {
    const labels = settingsNavItemsFor("tauri").map((item) => item.labelKey)
    const after = (label: (typeof labels)[number]) =>
      labels[labels.indexOf(label) + 1]
    expect(after("general")).toBe("collaboration")
    // 本地扩展把「输入收藏」页插在快速消息与浏览器之间，顺序断言需跟着走。
    expect(after("quick_messages")).toBe("prompt_stash")
    expect(after("prompt_stash")).toBe("browser")
    expect(after("browser")).toBe("computer_use")
  })

  it("keeps every page on the desktop", () => {
    const labels = settingsNavItemsFor("tauri").map((item) => item.labelKey)
    expect(labels).toContain("web_service")
    expect(labels).toContain("browser")
  })

  it("offers the AI assistant page next to the providers it reuses", () => {
    const labels = settingsNavItemsFor("tauri").map((item) => item.labelKey)
    // AI 助手不另存密钥，直接用某条 AI 提供方的端点与密钥
    // （docs/adr/0001），所以它的入口紧挨着模型提供方页。
    expect(labels[labels.indexOf("model_providers") + 1]).toBe("ai_assistant")
  })
})

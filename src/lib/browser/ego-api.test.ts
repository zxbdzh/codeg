import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

describe("Ego 设备标识的局域网兼容性", () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  function withoutSecureUuid() {
    const original = globalThis.crypto
    vi.stubGlobal("crypto", {
      getRandomValues: original.getRandomValues.bind(original),
    })
  }

  it("局域网 HTTP 首次打开时仍生成有效标识并持久复用", async () => {
    withoutSecureUuid()
    const { egoClientId } = await import("./ego-api")
    const clientId = egoClientId()
    expect(clientId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(localStorage.getItem("ego:device-id")).toBe(clientId)
    expect(egoClientId()).toBe(clientId)
  })

  it("局域网 HTTP 禁止读取存储时复用同一文档的临时标识", async () => {
    withoutSecureUuid()
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError")
    })
    const { egoClientId } = await import("./ego-api")
    const clientId = egoClientId()
    expect(clientId).toHaveLength(36)
    expect(egoClientId()).toBe(clientId)
  })

  it("存储写入失败时不改变当前文档的设备身份", async () => {
    withoutSecureUuid()
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage full", "QuotaExceededError")
    })
    const { egoClientId } = await import("./ego-api")
    const clientId = egoClientId()
    expect(clientId).toHaveLength(36)
    expect(egoClientId()).toBe(clientId)
  })

  it("已有设备标识不因局域网访问而改变人工归属", async () => {
    localStorage.setItem("ego:device-id", "existing-device-owner")
    withoutSecureUuid()
    const { egoClientId } = await import("./ego-api")
    expect(egoClientId()).toBe("existing-device-owner")
  })
})

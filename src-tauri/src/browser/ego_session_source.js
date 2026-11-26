let result
let task
try {
  const available = await profiles()
  if (
    request.mode === "read" &&
    !available.some((profile) => String(profile.id) === request.profileId)
  ) {
    result = { error: "source_missing" }
  } else if (request.mode === "profiles") {
    result = {
      profiles: available.map((profile) => ({
        id: String(profile.id),
        name: String(profile.name).slice(0, 160),
        isDefault: profile.isDefault === true,
      })),
    }
  } else {
    const url = new URL(request.url)
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !url.href.startsWith(url.origin + "/")
    ) {
      throw new Error("unsupported")
    }
    const profile = available.find(
      (entry) => String(entry.id) === request.profileId
    )
    task = await taskSpace(
      `Codeg sign-in ${Date.now()}-${Math.random().toString(36).slice(2)}`,
      { profileId: profile.id }
    )
    const page = task.page("p1")
    // 文档提交后即可读取同源存储，不必等图片和第三方资源全部加载。
    await page.goto(url.href, { timeout: 15000, waitUntil: "commit" })
    if (new URL(await page.url()).origin !== url.origin) {
      throw new Error("origin_changed")
    }
    const storage = await page.evaluate((expectedOrigin) => {
      if (location.origin !== expectedOrigin) throw new Error("origin_changed")
      const entries = Object.entries(localStorage)
      if (entries.length > 1024) throw new Error("storage_too_large")
      return Object.fromEntries(entries)
    }, url.origin)
    const { cookies } = await page.cdp("Network.getCookies", {
      urls: [url.href],
    })
    if (!Array.isArray(cookies) || cookies.length > 256)
      throw new Error("cookies_too_large")
    result = { origin: url.origin, cookies, storage }
  }
} catch (error) {
  result = {
    error: [
      "unsupported",
      "origin_changed",
      "storage_too_large",
      "cookies_too_large",
    ].includes(error?.message)
      ? "unsupported"
      : "unavailable",
  }
} finally {
  if (
    task &&
    task.ownership !== "user" &&
    task.ownership !== "agentDelegatedToUser"
  ) {
    try {
      await task.finish({ keep: [] })
    } catch {
      result = { error: "unavailable" }
    }
  }
}
console.log(JSON.stringify(result))

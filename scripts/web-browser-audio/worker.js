chrome.action.onClicked.addListener(async (tab) => {
  try {
    globalThis.__codegAudioLast = { tabId: tab.id, pending: true }
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["USER_MEDIA"],
        justification: "Stream only the Codeg tab selected by its user",
      })
    }
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id,
    })
    const response = await chrome.runtime.sendMessage({
      target: "offscreen",
      streamId,
      tabId: tab.id,
    })
    if (!response?.started)
      throw new Error(response?.error || "音频录制器未确认启动")
    globalThis.__codegAudioLast = { tabId: tab.id, pending: false }
  } catch (error) {
    globalThis.__codegAudioLast = { tabId: tab.id, error: error.message }
    console.error("Codeg audio capture:", error.message)
  }
})
globalThis.__codegAudioReady = true

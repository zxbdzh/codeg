chrome.action.onClicked.addListener(async (tab) => {
  try {
    globalThis.__codegVideoLast = { tabId: tab.id, pending: true }
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id,
    })
    const result = await chrome.runtime.sendMessage({
      target: "video-offscreen",
      streamId,
      tabId: tab.id,
    })
    if (!result?.started) throw new Error(result?.error || "视频采集未启动")
    globalThis.__codegVideoLast = { tabId: tab.id, pending: false }
  } catch (error) {
    globalThis.__codegVideoLast = { tabId: tab.id, error: error.message }
  }
})
globalThis.__codegVideoReady = true

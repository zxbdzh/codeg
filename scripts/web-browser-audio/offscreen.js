const recordings = new Map()
const starts = new Map()
const pending = []
globalThis.__codegFlushAudio = () => {
  for (const { tabId, recorder, message } of pending.splice(0))
    if (recordings.get(tabId) === recorder) globalThis.__codegAudio(message)
}
globalThis.__codegStopAudio = (tabId) => {
  starts.delete(tabId)
  recordings.get(tabId)?.stop()
  recordings.delete(tabId)
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "offscreen") return
  globalThis.__codegStopAudio(message.tabId)
  const starting = {}
  starts.set(message.tabId, starting)
  let stream
  void (async () => {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: message.streamId,
        },
      },
      video: false,
    })
    // 停止操作必须覆盖尚未返回的采集请求，不能在用户关闭后悄悄启动。
    if (starts.get(message.tabId) !== starting)
      throw new Error("音频采集已取消")
    const recorder = new MediaRecorder(stream, {
      mimeType: "audio/webm;codecs=opus",
      audioBitsPerSecond: 96000,
    })
    recorder.ondataavailable = async ({ data }) => {
      if (!data.size || recordings.get(message.tabId) !== recorder) return
      const buffer = new Uint8Array(await data.arrayBuffer())
      if (recordings.get(message.tabId) !== recorder) return
      let encoded = ""
      for (const byte of buffer) encoded += String.fromCharCode(byte)
      const messageText = JSON.stringify({
        tabId: message.tabId,
        data: btoa(encoded),
      })
      if (typeof globalThis.__codegAudio === "function")
        globalThis.__codegAudio(messageText)
      else {
        pending.push({ tabId: message.tabId, recorder, message: messageText })
        if (pending.length > 20) pending.shift()
      }
    }
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop())
      if (recordings.get(message.tabId) === recorder) {
        recordings.delete(message.tabId)
        starts.delete(message.tabId)
      }
    }
    recordings.set(message.tabId, recorder)
    recorder.start(160)
    sendResponse({ started: true })
  })().catch((error) => {
    stream?.getTracks().forEach((track) => track.stop())
    if (starts.get(message.tabId) === starting) {
      starts.delete(message.tabId)
      recordings.delete(message.tabId)
    }
    sendResponse({ error: error.message })
  })
  // 保持消息通道，worker 收到成功回执时录制器才真正可用。
  return true
})

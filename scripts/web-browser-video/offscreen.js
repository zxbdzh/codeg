const sessions = new Map()
const prepared = new Map()
const MAX_CREDITS = 12
const VIDEO_FPS = 60

globalThis.__codegPrepareVideo = (tabId, setup) => {
  prepared.set(tabId, setup)
}
globalThis.__codegStopVideo = (tabId, endpoint) => {
  if (!endpoint || prepared.get(tabId)?.endpoint === endpoint)
    prepared.delete(tabId)
  const session = sessions.get(tabId)
  if (!session || (endpoint && session.endpoint !== endpoint)) return
  sessions.delete(tabId)
  session.reader?.cancel().catch(() => {})
  if (session.audio?.state === "recording") session.audio.stop()
  session.stream?.getTracks().forEach((track) => track.stop())
  if (session.encoder?.state !== "closed") session.encoder?.close()
  session.peer?.close()
  session.socket?.close()
}

async function startRtc(session, stunUrl, send, fail) {
  const peer = new RTCPeerConnection({
    iceServers: stunUrl ? [{ urls: stunUrl }] : [],
  })
  session.peer = peer
  const track = session.stream.getVideoTracks()[0]
  // 网页文字不能为保帧率缩成低分辨率后再放大；负载高时优先降帧。
  track.contentHint = "text"
  const sender = peer.addTrack(track, session.stream)
  const parameters = sender.getParameters()
  parameters.degradationPreference = "maintain-resolution"
  Object.assign(parameters.encodings[0], {
    maxFramerate: VIDEO_FPS,
    maxBitrate: 6_000_000,
    scaleResolutionDownBy: 1,
  })
  await sender.setParameters(parameters)
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === "failed") fail(new Error("WebRTC 连接失败"))
  }
  track.addEventListener("ended", () => fail(new Error("视频采集已结束")), {
    once: true,
  })

  const control = peer.createDataChannel("input")
  const hover = peer.createDataChannel("hover", {
    ordered: false,
    maxRetransmits: 0,
  })
  let lastPointer = 0
  let dragging = false
  // 拖拽走有序通道。迟到的悬停不能把指针移回点击前的位置。
  control.onmessage = ({ data }) => {
    if (typeof data !== "string" || data.length > 210_000) return
    try {
      const { input, sequence } = JSON.parse(data)
      if (input?.type === "pointer") {
        lastPointer = Math.max(lastPointer, sequence)
        dragging = Boolean(input.buttons)
      }
      if (["pointer", "text", "key"].includes(input?.type))
        send({ type: "rtc-input", input })
    } catch {}
  }
  hover.onmessage = ({ data }) => {
    if (dragging || typeof data !== "string" || data.length > 1024) return
    try {
      const { input, sequence } = JSON.parse(data)
      if (
        !Number.isSafeInteger(sequence) ||
        sequence <= lastPointer ||
        input?.type !== "pointer" ||
        input.event !== "mouseMoved" ||
        input.buttons
      )
        return
      lastPointer = sequence
      send({ type: "rtc-input", input })
    } catch {}
  }

  const remoteCandidates = []
  let signaling = Promise.resolve()
  session.rtcSignal = (message) => {
    // ICE 候选可以先于 SDP 到达，等远端描述生效后再添加。
    signaling = signaling
      .then(async () => {
        if (message.type === "rtc-answer") {
          await peer.setRemoteDescription({ type: "answer", sdp: message.sdp })
          for (const candidate of remoteCandidates.splice(0))
            await peer.addIceCandidate(candidate)
        } else if (peer.remoteDescription) {
          await peer.addIceCandidate(message.candidate)
        } else {
          remoteCandidates.push(message.candidate)
        }
      })
      .catch(fail)
  }
  const localCandidates = []
  let offerSent = false
  const emitCandidate = (candidate) => send({ type: "rtc-ice", candidate })
  peer.onicecandidate = ({ candidate }) => {
    if (!candidate?.candidate) return
    if (offerSent) emitCandidate(candidate.toJSON())
    else localCandidates.push(candidate.toJSON())
  }
  const offer = await peer.createOffer()
  await peer.setLocalDescription(offer)
  send({ type: "rtc-offer", sdp: offer.sdp })
  offerSent = true
  localCandidates.forEach(emitCandidate)
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.target !== "video-offscreen") return
  const setup = prepared.get(message.tabId)
  prepared.delete(message.tabId)
  if (!setup) {
    respond({ error: "没有经过授权的视频采集连接" })
    return
  }
  globalThis.__codegStopVideo(message.tabId)
  const session = {
    endpoint: setup.endpoint,
    credits: MAX_CREDITS,
    keyFrame: true,
    frames: 0,
  }
  sessions.set(message.tabId, session)
  const active = () => sessions.get(message.tabId) === session
  void (async () => {
    const socket = new WebSocket(setup.endpoint)
    session.socket = socket
    const send = (value) => {
      if (active() && socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(value))
    }
    const fail = (error) => {
      send({ type: "video-error", message: error.message })
      globalThis.__codegStopVideo(message.tabId, setup.endpoint)
    }
    await new Promise((resolve, reject) => {
      socket.onopen = resolve
      socket.onerror = () => reject(new Error("视频本机连接失败"))
    })
    socket.onclose = () =>
      globalThis.__codegStopVideo(message.tabId, setup.endpoint)
    session.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: message.streamId,
        },
      },
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: message.streamId,
          minWidth: setup.width,
          maxWidth: setup.width,
          minHeight: setup.height,
          maxHeight: setup.height,
          minFrameRate: VIDEO_FPS,
          // 留出采样余量，避免把间隔不均匀的 60 FPS 页面更新节流掉。
          maxFrameRate: VIDEO_FPS * 2,
        },
      },
    })
    if (!active()) {
      session.stream.getTracks().forEach((track) => track.stop())
      throw new Error("视频采集已取消")
    }
    socket.onmessage = ({ data }) => {
      try {
        const control = JSON.parse(data)
        if (control.type === "rtc-answer" || control.type === "rtc-ice")
          session.rtcSignal?.(control)
        if (control.type === "credit")
          session.credits = Math.min(
            MAX_CREDITS,
            session.credits + control.count
          )
        if (control.type === "audio") {
          if (session.audio?.state === "recording") session.audio.stop()
          session.audio = null
          if (control.enabled) {
            const audio = new MediaRecorder(
              new MediaStream(session.stream.getAudioTracks()),
              { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 96000 }
            )
            session.audio = audio
            let chunks = Promise.resolve()
            audio.ondataavailable = ({ data }) => {
              chunks = chunks.then(async () => {
                if (!active() || session.audio !== audio || !data.size) return
                const bytes = new Uint8Array(await data.arrayBuffer())
                let binary = ""
                for (const byte of bytes) binary += String.fromCharCode(byte)
                send({ type: "audio", data: btoa(binary) })
              })
            }
            send({
              type: "audio-start",
              mime: "audio/webm;codecs=opus",
            })
            audio.start(120)
          } else send({ type: "audio-stop" })
        }
      } catch (error) {
        fail(error)
      }
    }
    if (setup.rtc) {
      await startRtc(session, setup.stunUrl, send, fail)
      respond({ started: true })
      return
    }
    const targetWidth = Math.max(2, Math.round(setup.width) & ~1)
    const targetHeight = Math.max(2, Math.round(setup.height) & ~1)
    let width = 0
    let height = 0
    const encoder = new VideoEncoder({
      output(chunk) {
        if (!active() || socket.readyState !== WebSocket.OPEN) return
        const packet = new Uint8Array(13 + chunk.byteLength)
        const view = new DataView(packet.buffer)
        view.setUint32(0, 0x43475631)
        view.setUint8(4, chunk.type === "key" ? 1 : 0)
        view.setFloat64(5, chunk.timestamp)
        chunk.copyTo(packet.subarray(13))
        socket.send(packet)
      },
      error: fail,
    })
    session.encoder = encoder
    const track = session.stream.getVideoTracks()[0]
    const processor = new MediaStreamTrackProcessor({ track })
    session.reader = processor.readable.getReader()
    respond({ started: true, settings: track.getSettings() })
    let scaling
    while (active()) {
      const { value: captured, done } = await session.reader.read()
      if (done) {
        if (active()) fail(new Error("视频采集已结束"))
        break
      }
      if (session.credits < 1 || encoder.encodeQueueSize > 2) {
        captured.close()
        continue
      }
      let frame = captured
      const nextWidth = targetWidth
      const nextHeight = targetHeight
      try {
        if (width !== nextWidth || height !== nextHeight) {
          width = nextWidth
          height = nextHeight
          const config = {
            codec: "vp8",
            width,
            height,
            bitrate: 6000000,
            framerate: VIDEO_FPS,
            latencyMode: "realtime",
          }
          const supported = await VideoEncoder.isConfigSupported(config)
          if (!supported.supported)
            throw new Error("浏览器不支持低延迟视频编码")
          encoder.configure(config)
          session.keyFrame = true
          send({ type: "video-start", codec: config.codec, width, height })
        }
        if (
          captured.displayWidth !== width ||
          captured.displayHeight !== height
        ) {
          // 部分捕获设备忽略轨道尺寸约束，编码前必须缩到网页视口以减少负载。
          scaling ??= new OffscreenCanvas(width, height)
          scaling.getContext("2d").drawImage(captured, 0, 0, width, height)
          frame = new VideoFrame(scaling, { timestamp: captured.timestamp })
        }
        // 信用在编码前扣除；网络慢时丢弃未编码原帧，不破坏已编码帧的引用链。
        session.credits--
        encoder.encode(frame, {
          keyFrame: session.keyFrame || session.frames % 120 === 0,
        })
        session.frames++
        session.keyFrame = false
      } finally {
        if (frame !== captured) frame.close()
        captured.close()
      }
    }
  })().catch((error) => {
    if (session.socket?.readyState === WebSocket.OPEN)
      session.socket.send(
        JSON.stringify({ type: "video-error", message: error.message })
      )
    globalThis.__codegStopVideo(message.tabId, setup.endpoint)
    respond({ error: error.message })
  })
  return true
})

type Send = (message: Record<string, unknown>) => void

export interface WebBrowserRtcOffer {
  id: number
  sdp: string
  width: number
  height: number
  stunUrl?: string
}

export class WebBrowserRtc {
  readonly peer: RTCPeerConnection
  private control?: RTCDataChannel
  private hover?: RTCDataChannel
  private sequence = 0
  private frameRequest?: number
  private firstFrame: ReturnType<typeof setTimeout>
  private disconnected?: ReturnType<typeof setTimeout>
  private closed = false
  private signaling: Promise<void>
  private candidates: RTCIceCandidateInit[] = []
  private answered = false
  active = false

  constructor(
    readonly offer: WebBrowserRtcOffer,
    private readonly element: HTMLVideoElement,
    private readonly signal: Send,
    onFrame: () => void,
    private readonly onFailure: () => void
  ) {
    const peer = new RTCPeerConnection({
      iceServers: offer.stunUrl ? [{ urls: offer.stunUrl }] : [],
    })
    this.peer = peer
    this.firstFrame = setTimeout(this.fail, 6000)
    peer.onconnectionstatechange = () => {
      clearTimeout(this.disconnected)
      if (peer.connectionState === "failed") this.fail()
      else if (peer.connectionState === "disconnected")
        this.disconnected = setTimeout(this.fail, 2500)
    }
    peer.ondatachannel = ({ channel }) => {
      if (channel.label === "input") {
        this.control = channel
        channel.onclose = this.fail
      } else if (channel.label === "hover") this.hover = channel
      else channel.close()
    }
    peer.ontrack = ({ track, receiver }) => {
      if (track.kind !== "video" || this.closed) return
      if ("jitterBufferTarget" in receiver) {
        // 交互画面优先呈现新帧，仍由浏览器按网络状态决定实际缓冲。
        receiver.jitterBufferTarget = 0
      }
      this.element.srcObject = new MediaStream([track])
      const show = () => {
        if (this.closed) return
        clearTimeout(this.firstFrame)
        onFrame()
        this.emit({ type: "rtc-ready" })
      }
      const requestVideoFrameCallback = (
        element as HTMLVideoElement & {
          requestVideoFrameCallback?: (callback: () => void) => number
        }
      ).requestVideoFrameCallback
      if (requestVideoFrameCallback) {
        this.frameRequest = requestVideoFrameCallback.call(element, show)
        void element.play().catch(this.fail)
      } else void element.play().then(show, this.fail)
    }
    peer.onicecandidate = ({ candidate }) => {
      if (!candidate?.candidate || this.closed) return
      const value = candidate.toJSON()
      if (this.answered) this.emit({ type: "rtc-ice", candidate: value })
      else this.candidates.push(value)
    }
    this.signaling = this.answer().catch(this.fail)
  }

  private emit(message: Record<string, unknown>) {
    if (!this.closed) this.signal({ ...message, id: this.offer.id })
  }

  private async answer() {
    await this.peer.setRemoteDescription({
      type: "offer",
      sdp: this.offer.sdp,
    })
    const answer = await this.peer.createAnswer()
    await this.peer.setLocalDescription(answer)
    this.emit({ type: "rtc-answer", sdp: answer.sdp })
    this.answered = true
    for (const candidate of this.candidates.splice(0))
      this.emit({ type: "rtc-ice", candidate })
  }

  addCandidate(candidate: RTCIceCandidateInit) {
    this.signaling = this.signaling
      .then(async () => {
        if (!this.closed) await this.peer.addIceCandidate(candidate)
      })
      .catch(this.fail)
  }

  sendInput(input: Record<string, unknown>) {
    if (
      !this.active ||
      !["pointer", "text", "key"].includes(String(input.type))
    )
      return false
    const hovering = input.event === "mouseMoved" && !input.buttons
    const channel = hovering ? this.hover : this.control
    if (channel?.readyState !== "open") return false
    if (hovering && channel.bufferedAmount > 1024) return true
    try {
      channel.send(JSON.stringify({ input, sequence: ++this.sequence }))
      return true
    } catch {
      return false
    }
  }

  private fail = () => {
    if (this.closed) return
    this.emit({ type: "rtc-fallback" })
    this.stop()
    this.onFailure()
  }

  stop() {
    this.closed = true
    clearTimeout(this.firstFrame)
    clearTimeout(this.disconnected)
    if (this.frameRequest !== undefined)
      this.element.cancelVideoFrameCallback(this.frameRequest)
    this.peer.close()
    this.element.srcObject = null
  }
}

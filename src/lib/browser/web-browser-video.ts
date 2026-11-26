export class WebBrowserVideo {
  private decoder: VideoDecoder | null = null
  private context: CanvasRenderingContext2D | null = null
  private timestamps = new Set<number>()
  private frames: VideoFrame[] = []
  private paintRequest: number | null = null

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onFrame: () => void,
    private readonly onAck: (timestamp: number) => void,
    private readonly onError: (error: Error) => void
  ) {}

  start(codec: string) {
    this.stop()
    if (codec !== "vp8") throw new Error("不支持的网站视频格式")
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (this.decoder !== decoder) {
          frame.close()
          return
        }
        // 保留一帧余量吸收接收抖动，避免相邻帧在同一次屏幕刷新中互相覆盖。
        if (this.frames.length === 2) {
          const stale = this.frames.shift()
          if (stale) this.release(stale)
        }
        this.frames.push(frame)
        if (this.paintRequest === null)
          this.paintRequest = requestAnimationFrame(this.paint)
      },
      error: (error) => {
        if (this.decoder !== decoder) return
        this.stop()
        this.onError(error)
      },
    })
    try {
      this.context = this.canvas.getContext("2d", {
        alpha: false,
        desynchronized: true,
      })
      decoder.configure({
        codec,
        optimizeForLatency: true,
      })
    } catch (error) {
      decoder.close()
      throw error
    }
    this.decoder = decoder
  }

  private paint = () => {
    this.paintRequest = null
    const frame = this.frames.shift()
    if (!frame) return
    try {
      if (this.canvas.width !== frame.displayWidth)
        this.canvas.width = frame.displayWidth
      if (this.canvas.height !== frame.displayHeight)
        this.canvas.height = frame.displayHeight
      this.context ??= this.canvas.getContext("2d", {
        alpha: false,
        desynchronized: true,
      })
      this.context?.drawImage(frame, 0, 0)
      this.onFrame()
    } catch (error) {
      this.stop()
      this.onError(error instanceof Error ? error : new Error(String(error)))
    } finally {
      this.release(frame)
    }
    if (this.frames.length)
      this.paintRequest = requestAnimationFrame(this.paint)
  }

  private release(frame: VideoFrame) {
    const timestamp = frame.timestamp
    frame.close()
    this.ack(timestamp)
  }

  append(packet: ArrayBuffer) {
    if (
      packet.byteLength < 14 ||
      new DataView(packet).getUint32(0) !== 0x43475631 ||
      this.decoder?.state !== "configured"
    )
      throw new Error("网站视频数据不完整")
    const view = new DataView(packet)
    const timestamp = view.getFloat64(5)
    if (!Number.isSafeInteger(timestamp) || timestamp < 0)
      throw new Error("无效的网站视频时间戳")
    this.timestamps.add(timestamp)
    // 绘制或主动舍弃后才确认，避免慢客户端持续积压。
    this.decoder.decode(
      new EncodedVideoChunk({
        type: view.getUint8(4) === 1 ? "key" : "delta",
        timestamp,
        data: new Uint8Array(packet, 13),
      })
    )
  }

  private ack(timestamp: number) {
    if (this.timestamps.delete(timestamp)) this.onAck(timestamp)
  }

  stop() {
    const decoder = this.decoder
    this.decoder = null
    this.context = null
    if (this.paintRequest !== null) cancelAnimationFrame(this.paintRequest)
    this.paintRequest = null
    for (const frame of this.frames) frame.close()
    this.frames.length = 0
    for (const timestamp of this.timestamps) this.onAck(timestamp)
    this.timestamps.clear()
    if (decoder && decoder.state !== "closed") decoder.close()
  }
}

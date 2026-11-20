export class WebBrowserAudio {
  private source: MediaSource | null = null
  private buffer: SourceBuffer | null = null
  private pending: Uint8Array<ArrayBuffer>[] = []
  private url: string | null = null

  constructor(
    private readonly element: HTMLAudioElement,
    private readonly onError: (failure: unknown) => void = () => {}
  ) {}

  start(mime: string) {
    this.stop()
    if (!MediaSource.isTypeSupported(mime))
      throw new Error("当前浏览器不支持网站音频格式")
    const source = new MediaSource()
    this.source = source
    this.url = URL.createObjectURL(source)
    this.element.src = this.url
    source.addEventListener(
      "sourceopen",
      () => {
        if (this.source !== source) return
        try {
          this.buffer = source.addSourceBuffer(mime)
          this.buffer.addEventListener("updateend", () => {
            if (this.source === source) this.flush()
          })
          this.buffer.addEventListener("error", () => {
            if (this.source === source)
              this.fail(new Error("网站音频解码失败，请重新开启声音"))
          })
          this.flush()
        } catch (failure) {
          this.fail(failure)
        }
      },
      { once: true }
    )
    // 先启动媒体加载才能收到 sourceopen；等待 sourceopen 后再 play 会互相等待。
    this.element.load()
    void this.element.play().catch(() => {})
  }

  append(data: string) {
    const binary = atob(data)
    this.pending.push(
      Uint8Array.from(binary, (character) => character.charCodeAt(0))
    )
    if (this.pending.length > 80)
      throw new Error("音频播放积压，请关闭声音后重新开启")
    this.flush()
  }

  private flush() {
    if (!this.buffer || this.buffer.updating || !this.pending.length) return
    try {
      if (this.buffer.buffered.length && this.element.currentTime > 30) {
        const oldest = this.buffer.buffered.start(0)
        if (oldest < this.element.currentTime - 25) {
          this.buffer.remove(oldest, this.element.currentTime - 20)
          return
        }
      }
      this.buffer.appendBuffer(this.pending.shift()!)
    } catch (failure) {
      this.fail(failure)
    }
  }

  private fail(failure: unknown) {
    this.stop()
    this.onError(failure)
  }

  stop() {
    this.element.pause()
    this.element.removeAttribute("src")
    const url = this.url
    this.source = null
    this.buffer = null
    this.url = null
    this.pending = []
    // 清空 src 后重新加载，才能真正解除媒体资源而不只是暂停播放。
    this.element.load()
    if (url) URL.revokeObjectURL(url)
  }
}

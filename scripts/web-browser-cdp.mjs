export class CdpConnection {
  constructor(url) {
    this.endpoint = url
    this.pending = new Map()
    this.sequence = 0
    this.listeners = new Set()
    this.socket = new WebSocket(url)
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("浏览器启动超时")),
        10000
      )
      this.socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout)
          resolve()
        },
        { once: true }
      )
      this.socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout)
          reject(new Error("浏览器连接失败"))
        },
        { once: true }
      )
    })
    this.socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data)
      const pending = this.pending.get(message.id)
      if (pending) {
        this.pending.delete(message.id)
        clearTimeout(pending.timeout)
        if (message.error)
          pending.reject(
            new Error(`${pending.method}: ${message.error.message}`)
          )
        else pending.resolve(message.result)
      } else for (const listener of this.listeners) listener(message)
    })
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout)
        pending.reject(new Error("浏览器连接已断开"))
      }
      this.pending.clear()
    })
  }

  async call(method, params = {}, sessionId) {
    await this.ready
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时`))
      }, 20000)
      this.pending.set(id, { resolve, reject, timeout, method })
      try {
        this.socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          })
        )
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(error)
      }
    })
  }
}

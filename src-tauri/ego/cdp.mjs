import { BrowserControlError } from "./control.mjs";

export class CdpConnection {
  constructor(socketUrl) {
    this.socket = new WebSocket(socketUrl);
    this.pending = new Map();
    this.listeners = new Set();
    this.nextId = 0;
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.socket.close();
        reject(new BrowserControlError("ego_unreachable", "无法连接 Ego 页面通道。"));
      }, 10000);
      this.socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new BrowserControlError("ego_unreachable", "无法连接 Ego 页面通道。"));
      }, { once: true });
    });
    this.socket.addEventListener("message", ({ data }) => {
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (!message.id) {
        for (const listener of this.listeners) listener(message);
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) {
        request.reject(new BrowserControlError("ego_command_failed", message.error.message));
      } else request.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new BrowserControlError(
          "ego_disconnected", "Ego 页面通道已中断，未确认结果的动作不会自动重放。"
        ));
      }
      this.pending.clear();
      for (const listener of this.listeners) listener({ method: "Codeg.disconnected" });
    });
  }

  async call(method, params = {}, sessionId) {
    await this.ready;
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new BrowserControlError("ego_disconnected", "Ego 页面通道已断开，请恢复后重试。");
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserControlError(
          "ego_timeout", "Ego 操作超时，结果尚未确认；请检查真实页面，避免重复提交。"
        ));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.socket.close();
  }
}

export function validateEndpoint(value) {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      endpoint.pathname !== "/") {
    throw new BrowserControlError("invalid_endpoint", "Ego 页面通道必须使用本机回环 HTTP 地址。");
  }
  return endpoint.origin;
}

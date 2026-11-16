import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { decodePixelPng } from "./pixel-png.mjs";

export class PixelDeliveryWindow {
  constructor() { this.revision = randomUUID(); this.nextId = 0; this.inFlight = []; this.lastId = 0; }
  reset() { this.revision = randomUUID(); this.inFlight = []; this.lastId = 0; }
  reserve() {
    if (this.inFlight.length >= 2) return null;
    const packet = { revision: this.revision, id: ++this.nextId, baseId: this.lastId };
    this.inFlight.push(packet); this.lastId = packet.id;
    return packet;
  }
  acknowledge(revision, id) {
    if (!Number.isSafeInteger(id) || this.inFlight[0]?.revision !== revision || this.inFlight[0]?.id !== id) return false;
    this.inFlight.shift(); return true;
  }
}

export class PixelStream {
  constructor(executable, response, binding, onClose) {
    if (!executable) throw new Error("无损显示编码器尚未配置。");
    this.id = randomUUID(); this.response = response; this.binding = binding; this.onClose = onClose;
    this.window = new PixelDeliveryWindow(); this.closed = false; this.pending = null; this.busy = false;
    this.executable = executable;
    response.once("close", () => this.close());
    this.lastAck = Date.now();
    this.heartbeat = setInterval(() => {
      if (this.window.inFlight.length && Date.now() - this.lastAck > 15000) this.close();
      else if (!this.closed && !response.writableNeedDrain) response.write("\n");
    }, 3000);
  }
  open(width, height) {
    if (this.child && this.width === width && this.height === height) return;
    this.child?.stdin.destroy(); this.child?.kill();
    this.width = width; this.height = height;
    // RGB边界明确，不会像PNG demux等待下一张图才释放本帧。
    const child = spawn(this.executable, ["-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${width}x${height}`, "-framerate", "30", "-probesize", "32", "-analyzeduration", "0", "-i", "pipe:0", "-an", "-c:v", "libwebp", "-lossless", "1", "-compression_level", "1", "-threads", "1", "-flush_packets", "1", "-f", "image2pipe", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    this.output = Buffer.alloc(0);
    this.child.stdout.on("data", chunk => {
      this.output = Buffer.concat([this.output, chunk]);
      if (this.output.length > 48 * 1024 * 1024) return this.close();
      if (this.output.length < 12) return;
      const size = this.output.readUInt32LE(4) + 8;
      if (size > 48 * 1024 * 1024) return this.close();
      if (this.output.length < size) return;
      const image = this.output.subarray(0, size); this.output = this.output.subarray(size);
      const waiting = this.waiting; this.waiting = null;
      try {
        let width, height;
        for (let offset = 12; offset + 13 <= image.length;) {
          const chunkSize = image.readUInt32LE(offset + 4);
          if (image.toString("ascii", offset, offset + 4) === "VP8L" && image[offset + 8] === 0x2f) {
            const dimensions = image.readUInt32LE(offset + 9); width = (dimensions & 0x3fff) + 1; height = ((dimensions >>> 14) & 0x3fff) + 1; break;
          }
          offset += 8 + chunkSize + (chunkSize & 1);
        }
        if (!width || !height) throw new Error("未收到有效的无损 WebP。");
        waiting?.resolve({ width, height, atlasWidth: width, atlasHeight: height,
          rectangles: [{ x: 0, y: 0, width, height, atlasY: 0 }], data: image.toString("base64") });
      } catch (error) { waiting?.reject(error); }
    });
    this.child.stderr.on("data", () => {});
    child.stdin.on("error", () => { if (this.child === child) this.close(); });
    child.on("error", () => { if (this.child === child) this.close(); });
    child.on("exit", () => { if (this.child === child) this.close(); });
  }
  write(frame) { if (!this.closed && frame.data) { this.pending = frame; void this.flush(); } }
  async flush() {
    if (this.closed || this.busy || !this.pending || this.window.inFlight.length >= 2 || this.response.writableNeedDrain) return;
    this.busy = true;
    const frame = this.pending; this.pending = null;
    try {
      const decoded = decodePixelPng(Buffer.from(frame.data, "base64"));
      const previous = this.previous;
      const sameSize = previous?.width === decoded.width && previous?.height === decoded.height;
      if (sameSize && decoded.data.equals(previous.data)) return;
      const rectangles = [];
      const stride = decoded.width * 3;
      if (!sameSize) rectangles.push({ x: 0, y: 0, width: decoded.width, height: decoded.height, atlasY: 0 });
      else for (let top = 0; top < decoded.height; top += 32) {
        const height = Math.min(32, decoded.height - top);
        let first = -1, last = -1;
        for (let row = top; row < top + height; row++) {
          const offset = row * stride;
          if (decoded.data.subarray(offset, offset + stride).equals(previous.data.subarray(offset, offset + stride))) continue;
          for (let column = 0; column < decoded.width; column += 128) {
            const width = Math.min(128, decoded.width - column), start = offset + column * 3;
            if (!decoded.data.subarray(start, start + width * 3).equals(previous.data.subarray(start, start + width * 3))) {
              first = first < 0 ? column : Math.min(first, column); last = Math.max(last, column + width);
            }
          }
        }
        if (first >= 0) rectangles.push({ x: first, y: top, width: last - first, height, atlasY: top });
      }
      // 图集保持固定编码尺寸；未变区域填白压缩，接收端只绘制带坐标的真实变化块。
      const atlas = sameSize ? Buffer.alloc(decoded.data.length, 255) : decoded.data;
      if (sameSize) for (const rectangle of rectangles) for (let row = rectangle.y; row < rectangle.y + rectangle.height; row++) {
        const start = row * stride + rectangle.x * 3;
        decoded.data.copy(atlas, row * stride, start, start + rectangle.width * 3);
      }
      this.open(decoded.width, decoded.height);
      const patch = await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("画面编码超时。")), 10000);
        this.waiting = { resolve: value => { clearTimeout(deadline); resolve(value); }, reject: error => { clearTimeout(deadline); reject(error); } };
        this.child.stdin.write(atlas, error => { if (error) reject(error); });
      });
      if (this.closed) return;
      if (patch.error) throw new Error("画面编码失败。");
      if (patch.noop) return;
      const sequence = this.window.reserve();
      if (!sequence) throw new Error("画面确认窗口已满。");
      // 每个观察端独立基准；已发送的增量绝不替换，拥塞时仅合并尚未编码的完整源帧。
      this.response.write(`${JSON.stringify({ ...patch, rectangles, ...sequence, kind: "pixel", streamId: this.id,
        tabId: this.binding.tabId, cssWidth: frame.width, cssHeight: frame.height,
        chooser: frame.chooser, dialog: frame.dialog })}\n`);
      this.previous = decoded;
    } catch { this.close(); }
    finally { this.busy = false; if (this.pending) void this.flush(); }
  }
  acknowledge(revision, id) {
    if (!this.window.acknowledge(revision, id)) return false;
    this.lastAck = Date.now(); void this.flush(); return true;
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.pending = null; clearInterval(this.heartbeat);
    this.waiting?.reject(new Error("画面连接结束。")); this.waiting = null;
    this.child?.stdin.destroy(); this.child?.kill(); this.onClose?.(); this.response.end();
  }
}

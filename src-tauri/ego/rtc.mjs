import { randomUUID } from "node:crypto";

export const rtcSenderSource = `(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 1280; canvas.height = 720;
  const context = canvas.getContext("2d", { alpha: false });
  const media = canvas.captureStream(0);
  const track = media.getVideoTracks()[0];
  track.contentHint = "text";
  let peer, channel, closed = false, decoding = false, pending = null;
  let width = 1280, height = 720, generation = 0;
  const notify = value => {
    if (channel?.readyState === "open") channel.send(JSON.stringify(value));
  };
  const draw = async () => {
    if (closed || decoding || !pending) return;
    const frame = pending; pending = null; decoding = true;
    try {
      const bytes = Uint8Array.from(atob(frame.data), character => character.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: frame.format === "png" ? "image/png" : "image/jpeg" }));
      if (closed) { image.close(); return; }
      // CDP 已限制采集尺寸；不要再缩到 1080p，否则小字在编码前就不可逆地丢失笔画。
      const scale = Math.min(1, 2560 / image.width, 1600 / image.height);
      const nextWidth = Math.max(2, Math.floor(image.width * scale / 2) * 2);
      const nextHeight = Math.max(2, Math.floor(image.height * scale / 2) * 2);
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth; canvas.height = nextHeight;
      }
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      image.close(); width = frame.width; height = frame.height;
      track.requestFrame();
    } finally { decoding = false; if (pending) void draw(); }
  };
  const heartbeat = setInterval(() => {
    if (closed) return;
    context.drawImage(canvas, 0, 0);
    track.requestFrame();
    notify({ kind: "metadata", width, height });
  }, 250);
  globalThis.__codegRtc = {
    frame(frame) { if (!closed) { pending = frame; void draw(); } },
    reply(value) { notify({ kind: "result", ...value }); },
    async open(offer, iceServers) {
      const current = ++generation;
      peer = new RTCPeerConnection({ iceServers });
      peer.ondatachannel = event => {
        if (event.channel.label !== "codeg-input") { event.channel.close(); return; }
        channel = event.channel;
        channel.onmessage = event => {
          if (typeof event.data !== "string" || event.data.length > 150000) return;
          globalThis.__codegRtcInput(event.data);
        };
      };
      await peer.setRemoteDescription(offer);
      const sender = peer.addTrack(track, media);
      const parameters = sender.getParameters();
      // 上限不是固定占用；保留文字分辨率，由拥塞控制降帧而不是积压旧帧。
      parameters.encodings = [{ maxBitrate: 16000000, maxFramerate: 30, scaleResolutionDownBy: 1 }];
      parameters.degradationPreference = "maintain-resolution";
      await sender.setParameters(parameters);
      await peer.setLocalDescription(await peer.createAnswer());
      await new Promise(resolve => {
        if (peer.iceGatheringState === "complete") return resolve();
        const timer = setTimeout(resolve, iceServers.length ? 3000 : 800);
        peer.addEventListener("icegatheringstatechange", () => {
          if (peer.iceGatheringState === "complete") { clearTimeout(timer); resolve(); }
        });
      });
      if (closed || current !== generation) throw new Error("rtc_cancelled");
      return { type: peer.localDescription.type, sdp: peer.localDescription.sdp };
    },
    status() { return { state: peer?.connectionState, width: canvas.width, height: canvas.height }; },
    close() {
      closed = true; generation++; clearInterval(heartbeat); pending = null;
      channel?.close(); peer?.close(); track.stop();
    },
  };
  return { supported: !!track.requestFrame, capture: "cdp-canvas" };
})()`;

export class EgoRtcConnection {
  constructor(browser, onInput) {
    this.browser = browser;
    this.onInput = onInput;
    this.id = randomUUID();
    this.closed = false;
    this.pending = null;
    this.writing = false;
  }

  async start(offer, iceServers = []) {
    try {
      // hidden target 由此 CDP 会话持有，不创建可见窗口、不激活用户标签。
      const created = await this.browser.call("Target.createTarget", { url: "about:blank", hidden: true });
      this.targetId = created.targetId;
      const attached = await this.browser.call("Target.attachToTarget", { targetId: this.targetId, flatten: true });
      this.sessionId = attached.sessionId;
      await this.browser.call("Runtime.enable", {}, this.sessionId);
      this.unsubscribe = this.browser.subscribe(event => {
        if (event.sessionId === this.sessionId && event.method === "Runtime.bindingCalled" &&
            event.params.name === "__codegRtcInput") {
          void this.onInput(event.params.payload).then(
            result => this.reply(result),
            () => this.reply({ error: { code: "rtc_input_failed", message: "页面操作失败，未自动重放。" } }),
          );
        }
      });
      await this.browser.call("Runtime.addBinding", { name: "__codegRtcInput" }, this.sessionId);
      await this.evaluate(rtcSenderSource);
      const answer = await this.evaluate(`__codegRtc.open(${JSON.stringify(offer)}, ${JSON.stringify(iceServers)})`);
      return { id: this.id, answer, capture: "cdp-canvas" };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async evaluate(expression) {
    const response = await this.browser.call("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
    }, this.sessionId);
    if (response.exceptionDetails) throw new Error("WebRTC 发送端初始化失败。");
    return response.result?.value;
  }

  write(frame) {
    if (this.closed || !frame.data) return;
    this.pending = frame;
    if (!this.writing) void this.flush();
  }

  async flush() {
    this.writing = true;
    try {
      while (!this.closed && this.pending) {
        const frame = this.pending;
        this.pending = null;
        await this.evaluate(`__codegRtc.frame(${JSON.stringify(frame)})`);
      }
    } catch { await this.close(); }
    finally { this.writing = false; }
  }

  async reply(value) {
    if (!this.closed) await this.evaluate(`__codegRtc.reply(${JSON.stringify(value)})`).catch(() => {});
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.pending = null;
    this.unsubscribe?.();
    this.onClose?.();
    if (this.targetId) await this.browser.call("Target.closeTarget", { targetId: this.targetId }).catch(() => {});
  }
}

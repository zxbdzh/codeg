import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { EgoRtcConnection, rtcSenderSource } from "./rtc.mjs";
import { EgoBroker } from "./broker.mjs";

test("文字画面保留采集分辨率，不再强制缩成 1080p，仍限制帧率与码率", async () => {
  let parameters;
  const track = { requestFrame() {}, stop() {} };
  const context = { drawImage() {} };
  const canvas = {
    getContext: () => context,
    captureStream: () => ({ getVideoTracks: () => [track] }),
  };
  const sandbox = {
    document: { createElement: () => canvas },
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout,
    atob: () => "image", Blob,
    createImageBitmap: async () => ({ width: 2548, height: 1330, close() {} }),
    RTCPeerConnection: class {
      iceGatheringState = "complete";
      localDescription = { type: "answer", sdp: "answer" };
      async setRemoteDescription() {}
      addTrack() {
        return { getParameters: () => ({}), async setParameters(value) { parameters = value; } };
      }
      async createAnswer() { return this.localDescription; }
      async setLocalDescription() {}
    },
  };
  runInNewContext(rtcSenderSource, sandbox);
  await sandbox.__codegRtc.open({ type: "offer", sdp: "offer" }, []);
  sandbox.__codegRtc.frame({ data: "data", width: 2548, height: 1330 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(canvas.width, 2548);
  assert.equal(canvas.height, 1330);
  assert.equal(track.contentHint, "text");
  assert.equal(parameters.encodings[0].scaleResolutionDownBy, 1);
  assert.equal(parameters.encodings[0].maxFramerate, 30);
  assert.equal(parameters.encodings[0].maxBitrate, 16000000);
  assert.equal(parameters.degradationPreference, "maintain-resolution");
});

test("WebRTC 发送目标隐藏且不激活窗口，失败也清理自己的目标", async () => {
  const calls = [];
  const browser = {
    subscribe() { return () => {}; },
    async call(method, params) {
      calls.push({ method, params });
      if (method === "Target.createTarget") return { targetId: "hidden" };
      if (method === "Target.attachToTarget") return { sessionId: "rtc" };
      if (method === "Runtime.evaluate") return { result: { value: { type: "answer", sdp: "answer" } } };
      return {};
    },
  };
  const rtc = new EgoRtcConnection(browser, async () => ({}));
  await rtc.start({ type: "offer", sdp: "offer" });
  assert.equal(calls.find(call => call.method === "Target.createTarget").params.hidden, true);
  assert.equal(calls.some(call => /activate|bringToFront/.test(call.method)), false);
  await rtc.close();
  await rtc.close();
  assert.equal(calls.filter(call => call.method === "Target.closeTarget").length, 1);
  assert.equal(calls.at(-1).params.targetId, "hidden");
});

function fixture() {
  let input;
  const broker = new EgoBroker({ dataDir: process.cwd(), endpoint: "http://127.0.0.1:9222",
    rtcFactory: (_browser, handler) => {
      input = handler;
      return { id: "rtc-one", closed: false, async start() { return { id: this.id, answer: { type: "answer", sdp: "answer" }, capture: "cdp-canvas" }; },
        write() {}, async close() { if (!this.closed) { this.closed = true; this.onClose?.(); } } };
    },
  });
  const group = broker.group(7);
  group.tabs = [{ id: "page", live: true }];
  broker.save = async () => {};
  broker.handOff = async () => {};
  broker.page = async (selected, id) => {
    assert.equal(selected, group);
    if (id !== "page") throw new Error("wrong target");
    return { tab: group.tabs[0] };
  };
  broker.watchFrames = async () => () => {};
  broker.humanAction = async (_group, _page, action) => action.kind === "context"
    ? { selection: "private", linkUrl: null, handled: false } : undefined;
  return { broker, group, input: payload => input(JSON.stringify(payload)) };
}

test("观看 WebRTC 不接管，数据输入逐次校验 epoch 和设备，不接受自报 target", async () => {
  const state = fixture();
  await state.broker.rtcOffer({ sessionId: 7, clientId: "device-first", tabId: "page", offer: { type: "offer", sdp: "offer" } });
  assert.equal(state.group.control.owner, null);
  const first = await state.input({ id: 1, kind: "human", epoch: state.group.control.epoch,
    sessionId: 99, clientId: "fake-device", tabId: "other-page", action: { kind: "text", text: "input" } });
  assert.equal(first.result.control.owner, "device-first");
  state.group.control.owner = "device-second";
  state.group.control.epoch++;
  const denied = await state.input({ id: 2, kind: "human", epoch: state.group.control.epoch, action: { kind: "text", text: "no" } });
  assert.equal(denied.error.code, "read_only");
  const invalid = await state.input({ id: 3, kind: "human", epoch: state.group.control.epoch, action: { kind: "return" } });
  assert.equal(invalid.error.code, "invalid_rtc_input");
  await state.broker.rtcClose({ sessionId: 7, clientId: "device-first", id: "rtc-one" });
});

test("恢复门禁和跨会话关闭仍受保护，选区不进入其他观看者快照", async () => {
  const state = fixture();
  const request = { sessionId: 7, clientId: "device-first", tabId: "page", offer: { type: "offer", sdp: "offer" } };
  state.group.control.recoveryRequired = true;
  await assert.rejects(state.broker.rtcOffer(request), error => error.code === "recovery_required");
  state.group.control.recoveryRequired = false;
  await state.broker.rtcOffer(request);
  try {
    const result = await state.input({ id: 4, kind: "human", epoch: state.group.control.epoch, action: { kind: "context", x: 1, y: 1 } });
    assert.equal(result.result.contextMenu.selection, "private");
    assert.equal((await state.input({ id: 5, kind: "ping" })).result.contextMenu, undefined);
    await assert.rejects(state.broker.rtcClose({ sessionId: 99, clientId: "device-first", id: "rtc-one" }), error => error.code === "read_only");
  } finally { await state.broker.rtcClose({ sessionId: 7, clientId: "device-first", id: "rtc-one" }); }
});

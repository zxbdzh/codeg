import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createVideoEncoder } from "./video.mjs";

function fixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let killed = false;
  child.kill = () => { killed = true; };
  const response = new Writable({ write(chunk, encoding, done) { done(); } });
  response.writeHead = () => {};
  response.flushHeaders = () => {};
  const calls = [];
  const spawn = (executable, args, options) => {
    calls.push({ executable, args, options });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  return { child, response, calls, spawn, killed: () => killed };
}

test("视频未配置编码器时明确拒绝，保留原画面通道", async () => {
  await assert.rejects(createVideoEncoder({}, { executable: "" }), /编码器/);
});

test("视频编码固定节奏只取最新帧，断开即释放自己的进程", async context => {
  const state = fixture();
  const encoder = await createVideoEncoder(state.response, { executable: "encoder.exe", spawn: state.spawn, intervalMs: 10 });
  context.after(() => encoder.close());
  const bytes = [];
  state.child.stdin.on("data", chunk => bytes.push(String(chunk)));
  encoder.write("first"); encoder.write("latest");
  await new Promise(resolve => setTimeout(resolve, 26));
  assert.ok(bytes.length > 0);
  assert.ok(bytes.every(value => value === "latest"));
  assert.equal(state.calls[0].options.windowsHide, true);
  assert.equal(state.calls[0].options.shell, false);
  assert.ok(state.calls[0].args.includes("zerolatency"));
  assert.ok(state.calls[0].args.some(argument => argument.includes("1920") && argument.includes("1080")), "大屏编码必须有像素上限，不能让帧率低于时钟后持续积累延迟");
  assert.ok(state.calls[0].args.includes("baseline"), "输出必须与前端协商的解码规格一致");
  assert.ok(state.calls[0].args.includes("4.2"));
  assert.ok(state.calls[0].args.includes("-use_wallclock_as_timestamps"));
  assert.ok(state.calls[0].args.includes("vfr"));
  encoder.close(); encoder.close();
  assert.equal(state.killed(), true);
});

test("编码器启动错误必须拒绝，不能把空响应当成视频成功", async () => {
  const state = fixture();
  await assert.rejects(createVideoEncoder(state.response, {
    executable: "missing.exe",
    spawn: () => { queueMicrotask(() => state.child.emit("error", new Error("ENOENT"))); return state.child; },
  }), /编码器/);
});

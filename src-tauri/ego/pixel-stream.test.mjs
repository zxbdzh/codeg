import assert from "node:assert/strict";
import { test } from "node:test";
import { PixelDeliveryWindow } from "./pixel-stream.mjs";

test("两帧上限不丢已发送依赖，绘制确认只接受顺序一致的当前代次", () => {
  const window = new PixelDeliveryWindow();
  const first = window.reserve();
  const second = window.reserve();
  assert.equal(first.baseId, 0);
  assert.equal(second.baseId, first.id);
  assert.equal(window.reserve(), null);
  assert.equal(window.acknowledge(second.revision, second.id), false);
  assert.equal(window.acknowledge(first.revision, first.id), true);
  assert.equal(window.reserve().baseId, second.id);
});

test("重新连接必须全量起步，旧确认不能释放新连接容量", () => {
  const window = new PixelDeliveryWindow();
  const old = window.reserve();
  window.reset();
  const first = window.reserve();
  assert.equal(first.baseId, 0);
  assert.equal(window.acknowledge(old.revision, old.id), false);
  assert.equal(window.inFlight.length, 1);
});

test("重复和非整数确认拒绝，不改变最后已确认画面", () => {
  const window = new PixelDeliveryWindow();
  const first = window.reserve();
  assert.equal(window.acknowledge(first.revision, first.id + 0.5), false);
  assert.equal(window.acknowledge(first.revision, first.id), true);
  assert.equal(window.acknowledge(first.revision, first.id), false);
  assert.equal(window.inFlight.length, 0);
});

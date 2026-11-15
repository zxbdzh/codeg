import assert from "node:assert/strict";
import test from "node:test";
import { PageGroupControl } from "./control.mjs";

test("接管等待在途动作，但立即拦截已排队的 Agent 动作", async () => {
  const control = new PageGroupControl();
  const operations = [];
  let release;
  const first = control.runAgent(async () => {
    operations.push("agent-start");
    await new Promise((resolve) => { release = resolve; });
    operations.push("agent-finished");
  });
  await Promise.resolve();
  const queued = control.runAgent(() => operations.push("resumed-agent"));
  const human = control.runHuman("device-one", control.epoch, () => {
    operations.push("human-input");
  });
  assert.equal(control.owner, "device-one");
  release();
  await Promise.all([first, human]);
  assert.deepEqual(operations, ["agent-start", "agent-finished", "human-input"]);
  await control.returnToAgent("device-one", control.epoch);
  await queued;
  assert.equal(operations.at(-1), "resumed-agent");
});

test("观看和断线不改控制权，转移后旧设备不能输入或交还", async () => {
  const control = new PageGroupControl();
  await control.runHuman("device-one", control.epoch, async () => {});
  const oldEpoch = control.epoch;
  assert.deepEqual(control.snapshot(), control.snapshot());
  assert.throws(
    () => control.runHuman("device-two", oldEpoch, async () => {}),
    { code: "read_only" }
  );
  await control.runHuman("device-two", oldEpoch, async () => {}, { transfer: true });
  assert.throws(
    () => control.runHuman("device-one", oldEpoch, async () => {}),
    { code: "stale_control" }
  );
  assert.throws(
    () => control.returnToAgent("device-one", control.epoch, async () => {}),
    { code: "read_only" }
  );
  let resumed = false;
  const waiting = control.runAgent(async () => { resumed = true; });
  await Promise.resolve();
  assert.equal(resumed, false);
  await control.returnToAgent("device-two", control.epoch, async () => {});
  await waiting;
  assert.equal(resumed, true);
  assert.equal(control.owner, null);
  await control.runAgent(async () => {});
});

test("人工恢复确认保留原接管设备，确认本身不能交还", async () => {
  const control = new PageGroupControl({
    owner: "device-one",
    epoch: 7,
    recoveryRequired: true,
  });
  let resumed = false;
  const waiting = control.runAgent(async () => { resumed = true; });
  control.confirmRecovery();
  assert.equal(control.owner, "device-one");
  await Promise.resolve();
  assert.equal(resumed, false);
  await control.returnToAgent("device-one", control.epoch);
  await waiting;
  assert.equal(resumed, true);
});

test("两组互不阻塞，排队的交还不能越过新设备接管", async () => {
  const first = new PageGroupControl();
  const second = new PageGroupControl();
  await first.runHuman("device-one", first.epoch, async () => {});
  let completed = false;
  await second.runAgent(async () => { completed = true; });
  assert.equal(completed, true);
  const returning = first.returnToAgent("device-one", first.epoch);
  const rejected = assert.rejects(returning, { code: "stale_control" });
  const transfer = first.runHuman("device-two", first.epoch, async () => {}, { transfer: true });
  await Promise.all([rejected, transfer]);
  assert.equal(first.owner, "device-two");
});

test("交还只改变控制授权，不执行异步原生恢复", async () => {
  const control = new PageGroupControl();
  await control.runHuman("device-one", control.epoch, async () => {});
  let unsafeResume = false;
  await control.returnToAgent("device-one", control.epoch, () => { unsafeResume = true; });
  assert.equal(unsafeResume, false);
  assert.equal(control.owner, null);
});

test("重启后另一设备可显式接管恢复，但确认前不能输入或续跑", async () => {
  const control = new PageGroupControl({ owner: "old-device", recoveryRequired: true });
  await control.runHuman("new-device", control.epoch, async () => {}, { transfer: true });
  assert.equal(control.owner, "new-device");
  assert.equal(control.recoveryRequired, true);
  assert.throws(() => control.runHuman("new-device", control.epoch, async () => {}), { code: "recovery_required" });
  control.confirmRecovery();
  assert.equal(control.owner, "new-device");
  const pending = control.runAgent(() => {
    assert.equal(control.nativeResumeAuthorized, true);
  });
  await control.returnToAgent("new-device", control.epoch);
  await pending;
});

test("桥接结束会拒绝等待交还的操作，不让旧请求跨恢复后执行", async () => {
  const control = new PageGroupControl({ owner: "device-one" });
  let executed = false;
  const pending = control.runAgent(() => { executed = true; });
  const rejected = assert.rejects(pending, { code: "ego_disconnected" });
  control.stop();
  await rejected;
  assert.equal(executed, false);
  assert.equal(control.owner, "device-one");
});

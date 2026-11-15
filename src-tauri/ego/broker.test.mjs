import { test } from "node:test";
import assert from "node:assert/strict";
import { EgoBroker } from "./broker.mjs";

function fixture() {
  const broker = new EgoBroker({ dataDir: process.cwd(), endpoint: "http://127.0.0.1:9222" });
  broker.save = async () => {};
  broker.handOff = async () => {};
  broker.open = async (group, url) => {
    const tab = { id: `page-${group.tabs.length + 1}`, url, live: true };
    group.tabs.push(tab);
    return tab;
  };
  broker.page = async (group, id) => ({ tab: group.tabs.find((tab) => tab.id === id) });
  broker.humanAction = async (group, page) => { group.tabs = group.tabs.filter((tab) => tab !== page.tab); };
  return broker;
}

test("查看空页面组不创建页面或接管；新网址只创建一次并绑定对应工作区标签", async () => {
  const broker = fixture();
  const initial = await broker.dispatch({ method: "visit", sessionId: 7, viewId: "entry", url: "about:blank" });
  assert.equal(initial.tabs.length, 0);
  assert.equal(initial.control.owner, null);
  const opened = await broker.dispatch({ method: "visit", sessionId: 7, viewId: "site", url: "https://example.com/", clientId: "this-device", epoch: initial.control.epoch });
  assert.equal(opened.tabs.length, 1);
  assert.equal(opened.views.site, opened.tabs[0].id);
  assert.equal(opened.control.owner, "this-device");
  const reconnect = await broker.dispatch({ method: "visit", sessionId: 7, viewId: "site", url: "https://example.com/" });
  assert.equal(reconnect.tabs.length, 1);
});

test("外层标签关闭只关闭绑定页，其他页保留；旧设备被拒绝且关闭不交还", async () => {
  const broker = fixture();
  const group = broker.group(7);
  await broker.open(group, "https://example.com/one");
  await broker.open(group, "https://example.com/two");
  group.views.outer = group.tabs[0].id;
  group.control.owner = "other-device";
  await assert.rejects(broker.dispatch({ method: "closeView", sessionId: 7, viewId: "outer", clientId: "this-device", epoch: group.control.epoch }), { code: "read_only" });
  const closed = await broker.dispatch({ method: "closeView", sessionId: 7, viewId: "outer", clientId: "other-device", epoch: group.control.epoch });
  assert.deepEqual(closed.tabs.map((tab) => tab.url), ["https://example.com/two"]);
  assert.equal(closed.control.owner, "other-device");
  const reload = await broker.dispatch({ method: "visit", sessionId: 7, viewId: "outer", url: "https://example.com/one" });
  assert.equal(reload.tabs.length, 1);
});

test("恢复前显式换设备仅更新归属，不调用尚未恢复的 Ego 页面组", async () => {
  const broker = fixture();
  const group = broker.group(7);
  group.control.owner = "old-device";
  group.control.recoveryRequired = true;
  broker.handOff = async () => { throw new Error("恢复前不应交付原生输入"); };
  const state = await broker.human({ sessionId: 7, clientId: "new-device", epoch: group.control.epoch, action: { kind: "takeover" } });
  assert.equal(state.control.owner, "new-device");
  assert.equal(state.control.recoveryRequired, true);
});

test("网页弹窗直接随上一帧送回，不等待可能阻塞的截图命令", async () => {
  const broker = fixture();
  const dialog = { type: "prompt", message: "请输入", defaultPrompt: "" };
  broker.page = async () => ({ lastFrame: { data: "previous-frame", width: 800, height: 600 }, dialog, chooser: null });
  broker.call = async () => { throw new Error("弹窗未处理前不应获取截图"); };
  const frame = await broker.frame({ sessionId: 7, tabId: "page-one" });
  assert.equal(frame.data, "previous-frame");
  assert.equal(frame.dialog, dialog);
});

test("点击触发弹窗时释放输入队列，确认不等待原点击完成且不自动交还", async () => {
  const broker = fixture();
  const group = broker.group(7);
  const page = { tab: { id: "page-one" }, sessionId: "cdp-one", dialog: null };
  broker.page = async () => page;
  broker.humanAction = EgoBroker.prototype.humanAction;
  const listeners = new Set();
  let finishClick;
  broker.browser = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async call(method) {
      if (method === "Input.dispatchMouseEvent") return new Promise((resolve) => { finishClick = resolve; });
      assert.equal(method, "Page.handleJavaScriptDialog");
      finishClick({});
      return {};
    },
  };
  const click = broker.human({ sessionId: 7, clientId: "this-device", epoch: group.control.epoch, tabId: page.tab.id, action: { kind: "pointer", type: "mouseReleased", x: 1, y: 1 } });
  while (!finishClick) await new Promise((resolve) => setImmediate(resolve));
  page.dialog = { type: "alert", message: "请确认" };
  for (const listener of listeners) listener({ method: "Page.javascriptDialogOpening", sessionId: page.sessionId });
  await click;
  assert.equal(group.control.owner, "this-device");
  await broker.human({ sessionId: 7, clientId: "this-device", epoch: group.control.epoch, tabId: page.tab.id, action: { kind: "dialog", accept: true } });
  assert.equal(page.dialog, null);
  assert.equal(group.control.owner, "this-device");
  assert.equal(listeners.size, 0);
});

test("其他页面弹窗不打断读取，本页弹窗中止读取且不伪造执行结果", async () => {
  const broker = fixture();
  const page = { sessionId: "cdp-one", dialog: null };
  let listener;
  let finish;
  let ended = false;
  broker.browser = {
    subscribe(callback) { listener = callback; return () => {}; },
    call() { return new Promise((resolve) => { finish = resolve; }); },
  };
  const result = broker.call(page, "Runtime.evaluate").finally(() => { ended = true; });
  listener({ method: "Page.javascriptDialogOpening", sessionId: "cdp-two" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ended, false);
  const rejected = assert.rejects(result, { code: "page_dialog" });
  listener({ method: "Page.javascriptDialogOpening", sessionId: page.sessionId });
  await rejected;
  finish({ result: { value: "late-result" } });
});

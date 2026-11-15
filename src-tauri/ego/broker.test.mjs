import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

function recoveryFixture() {
  const broker = new EgoBroker({ dataDir: process.cwd(), endpoint: "http://127.0.0.1:9222" });
  const group = broker.group(7);
  group.spaceId = 41;
  group.anchorId = "anchor";
  group.control.owner = "this-device";
  group.control.recoveryRequired = true;
  group.tabs = [
    { id: "old-one", url: "https://example.com/one", live: false },
    { id: "old-two", url: "https://example.com/two", live: false },
  ];
  group.views = { first: "old-one", alsoFirst: "old-one", second: "old-two", empty: null };
  const spaces = [{ id: 41, name: group.name, ownership: "agent" }];
  const targets = new Map([["anchor", { targetId: "anchor", url: "about:blank" }]]);
  const saved = [];
  const navigated = [];
  const faults = {
    openAttempts: 0, failOpenAt: null, navigationAttempts: 0, failNavigateAt: null,
    failSaveOnce: false, failConfirmationSaveOnce: false,
  };
  let selectedSpace = 41;
  let nextTarget = 0;
  broker.native = {
    async listTaskSpaces() { return { taskSpaces: spaces.map((space) => ({ ...space })) }; },
    async useTaskSpace(spaceId) { selectedSpace = spaceId; return {}; },
    async createTaskSpace(name) {
      const space = { id: 42, name, ownership: "agent" };
      spaces.push(space);
      return space;
    },
    async createTab(url) {
      const targetId = `anchor-${selectedSpace}`;
      targets.set(targetId, { targetId, url });
      return { targetId };
    },
    async handOffTaskSpace() {
      spaces.find((space) => space.id === selectedSpace).ownership = "agentDelegatedToUser";
      return {};
    },
    async takeOverTaskSpace() {
      spaces.find((space) => space.id === selectedSpace).ownership = "agent";
      return {};
    },
  };
  broker.browser = {
    subscribe() { return () => {}; },
    async call(method, params = {}, sessionId) {
      if (method === "Target.getTargets") return { targetInfos: [...targets.values()] };
      if (method === "Target.attachToTarget") {
        assert.ok(targets.has(params.targetId), "不能附着到已丢失的页面");
        return { sessionId: `session:${params.targetId}` };
      }
      const targetId = sessionId?.slice("session:".length);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: targetId } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      if (method === "Runtime.evaluate") {
        faults.openAttempts += 1;
        if (faults.openAttempts === faults.failOpenAt) throw new Error("页面创建失败");
        const openedId = `new-${++nextTarget}`;
        targets.set(openedId, { targetId: openedId, openerId: targetId, url: "about:blank" });
        return { result: { value: true } };
      }
      if (method === "Page.navigate") {
        faults.navigationAttempts += 1;
        if (faults.navigationAttempts === faults.failNavigateAt) throw new Error("页面导航失败");
        targets.get(targetId).url = params.url;
        navigated.push({ id: targetId, url: params.url });
        return {};
      }
      assert.ok(["Page.enable", "Runtime.enable", "Page.setInterceptFileChooserDialog"].includes(method), method);
      return {};
    },
  };
  broker.save = async () => {
    if (faults.failSaveOnce || (faults.failConfirmationSaveOnce && !group.control.recoveryRequired)) {
      faults.failSaveOnce = false;
      faults.failConfirmationSaveOnce = false;
      throw new Error("会话记录写入失败");
    }
    saved.push(structuredClone({
      tabs: group.tabs, views: group.views, control: group.control.snapshot(),
    }));
  };
  return { broker, group, spaces, targets, saved, navigated, faults };
}

test("非主动销毁记录只覆盖所属业务页和锚点，不把其他任务或无目标崩溃归给本组", async () => {
  const broker = fixture();
  const group = broker.group(7);
  group.spaceId = 41;
  group.anchorId = "anchor";
  group.control.owner = "this-device";
  group.tabs = [{ id: "page", url: "https://example.com/private", live: true }];
  const records = [];
  broker.recordLifecycle = async (type, entry, details) => { records.push({ type, sessionId: entry?.sessionId, ...details }); };
  await broker.event({ method: "Target.targetDestroyed", params: { targetId: "unrelated" } });
  await broker.event({ method: "Inspector.targetCrashed", sessionId: "unknown", params: {} });
  assert.deepEqual(records, []);
  await broker.event({ method: "Target.targetCrashed", params: { targetId: "page", errorCode: 5 } });
  await broker.event({ method: "Target.targetDestroyed", params: { targetId: "anchor" } });
  await broker.event({ method: "Target.targetDestroyed", params: { targetId: "page" } });
  assert.deepEqual(records.map((record) => [record.method, record.role, record.explicit]), [
    ["Target.targetCrashed", "page", false],
    ["Target.targetDestroyed", "anchor", false],
    ["Target.targetDestroyed", "page", false],
  ]);
  assert.ok(records.every((record) => record.sessionId === 7));
  assert.equal(group.control.recoveryRequired, true);
  assert.equal(group.control.owner, "this-device");
  assert.equal(group.tabs[0].url, "https://example.com/private");
});

test("只有通过归属校验的关闭才留下关闭意图，真实销毁与该意图关联且不交还", async () => {
  const broker = fixture();
  const group = broker.group(7);
  group.control.owner = "this-device";
  group.tabs = [{ id: "page", url: "https://example.com/", live: true }];
  group.views.outer = "page";
  const page = { group, tab: group.tabs[0], sessionId: "cdp-page" };
  broker.pages.set("page", page);
  broker.page = async () => page;
  broker.humanAction = EgoBroker.prototype.humanAction;
  broker.browser = { async call() { return { targetInfos: [] }; } };
  const records = [];
  broker.recordLifecycle = async (type, entry, details) => { records.push({ type, sessionId: entry?.sessionId, ...details }); };
  broker.call = async (_page, method) => {
    assert.equal(method, "Page.close");
    assert.equal(records[0].type, "close_requested", "关闭意图须先于真实关闭保存");
    await broker.event({ method: "Target.targetDestroyed", params: { targetId: "page" } });
    return {};
  };
  const request = { method: "closeView", sessionId: 7, viewId: "outer", epoch: group.control.epoch };
  await assert.rejects(broker.dispatch({ ...request, clientId: "other-device" }), { code: "read_only" });
  assert.deepEqual(records, []);
  await broker.dispatch({ ...request, clientId: "this-device" });
  assert.equal(records[0].source, "web-view");
  assert.equal(records[1].type, "target_event");
  assert.equal(records[1].explicit, true);
  assert.ok(records.every((record) => record.targetId === "page"));
  assert.equal(group.tabs.length, 0);
  assert.equal(group.control.owner, "this-device");
});

test("生命周期记录跨桥接保留并限制大小，不写页面内容、凭据或原始错误", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codeg-ego-journal-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const create = () => {
    const broker = new EgoBroker({ dataDir: directory, endpoint: "http://127.0.0.1:9222" });
    broker.lifecycleEnabled = true;
    return broker;
  };
  const first = create();
  await first.recordLifecycle("close_requested", first.group(7), {
    targetId: "page", source: "web-page", url: "private-url", text: "private-input",
    token: "private-token", message: "private-error", request: { cookie: "private-cookie" },
  });
  const filename = path.join(directory, "lifecycle.jsonl");
  const original = await fs.readFile(filename, "utf8");
  assert.doesNotMatch(original, /private-/);
  await fs.appendFile(filename, " ".repeat(256 * 1024));
  const second = create();
  await second.recordLifecycle("bridge_started");
  await second.recordLifecycle("cdp_disconnected", null, { explicit: false });
  const current = (await fs.readFile(filename, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const previous = await fs.readFile(path.join(directory, "lifecycle.previous.jsonl"), "utf8");
  assert.ok(previous.startsWith(original));
  assert.notEqual(current[0].runId, JSON.parse(original).runId);
  assert.deepEqual(current.map((record) => record.type), ["bridge_started", "cdp_disconnected"]);
  assert.ok((await fs.stat(filename)).size < 256 * 1024);
});

test("生命周期写入失败不改变业务结果且后续记录可继续", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codeg-ego-journal-failure-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const broker = new EgoBroker({ dataDir: path.join(directory, "missing"), endpoint: "http://127.0.0.1:9222" });
  broker.lifecycleEnabled = true;
  broker.native = { async createTaskSpace() { return { id: 41 }; } };
  assert.deepEqual(await broker.nativeCall(null, "createTaskSpace", "private-name"), { id: 41 });
  assert.equal(broker.lastLifecycleError, "ENOENT");
  await fs.mkdir(broker.root);
  await assert.rejects(broker.nativeCall(null, "nonexistentMethod"), TypeError);
  assert.deepEqual(await broker.nativeCall(null, "createTaskSpace", "private-name"), { id: 41 });
  const records = (await fs.readFile(path.join(broker.root, "lifecycle.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.find((record) => record.method === "nonexistentMethod" && record.outcome === "error").type, "native_result");
  assert.equal(records.at(-1).outcome, "ok");
});

test("切换 TaskSpace 返回错误对象时不执行后续方法，失败不阻塞下一次原生调用", async () => {
  const broker = fixture();
  const calls = [];
  broker.native = {
    async useTaskSpace(spaceId) {
      if (spaceId === 41) return { error_code: "EGO_TASK_SPACE_NOT_FOUND", error: "页面组已丢失" };
      return {};
    },
    async handOffTaskSpace() { calls.push("handoff"); return { accepted: true }; },
  };
  await assert.rejects(broker.nativeCall(41, "handOffTaskSpace"), {
    code: "EGO_TASK_SPACE_NOT_FOUND", message: "页面组已丢失",
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(await broker.nativeCall(42, "handOffTaskSpace"), { accepted: true });
  assert.deepEqual(calls, ["handoff"]);
});

test("Agent 发现 TaskSpace 丢失会保存恢复标志，Web 确认可重建未收到销毁事件的旧页", async () => {
  const { broker, group, spaces, targets, saved } = recoveryFixture();
  group.control.owner = null;
  group.control.recoveryRequired = false;
  for (const tab of group.tabs) tab.live = true;
  spaces.length = 0;
  targets.clear();
  await assert.rejects(broker.dispatch({ method: "agent", sessionId: 7, kind: "list" }), { code: "recovery_required" });
  const offline = await broker.dispatch({ method: "session", sessionId: 7 });
  assert.equal(offline.control.recoveryRequired, true);
  assert.equal(saved.at(-1).control.recoveryRequired, true);
  assert.ok(offline.tabs.every((tab) => !tab.live));
  const restored = await broker.dispatch({ method: "restore", sessionId: 7, clientId: "this-device", epoch: offline.control.epoch });
  assert.equal(restored.control.recoveryRequired, false);
  assert.deepEqual(restored.tabs.map((tab) => tab.url), ["https://example.com/one", "https://example.com/two"]);
  assert.equal(restored.views.first, restored.tabs[0].id);
  assert.equal(restored.views.second, restored.tabs[1].id);
  assert.ok(restored.tabs.every((tab) => tab.live && targets.has(tab.id)));
});

test("恢复第二页失败后保留首个成功页和 view 映射，重试不重复创建且人工暂停直到显式交还", async (context) => {
  const { broker, group, spaces, saved, navigated, faults } = recoveryFixture();
  faults.failOpenAt = 2;
  let agentResumed = false;
  const pending = broker.dispatch({ method: "agent", sessionId: 7, kind: "list" }).then((result) => {
    agentResumed = true;
    return result;
  });
  pending.catch(() => {});
  context.after(() => group.control.stop());
  const restore = () => broker.dispatch({ method: "restore", sessionId: 7, clientId: "this-device", epoch: group.control.epoch });
  await assert.rejects(restore(), /页面创建失败/);
  const partial = await broker.dispatch({ method: "session", sessionId: 7 });
  assert.equal(partial.tabs.length, 2);
  assert.equal(partial.tabs[0].live, true);
  assert.equal(partial.tabs[1].id, "old-two");
  assert.equal(partial.control.owner, "this-device");
  assert.equal(partial.control.recoveryRequired, true);
  assert.equal(spaces[0].ownership, "agentDelegatedToUser");
  assert.deepEqual(partial.views, { first: partial.tabs[0].id, alsoFirst: partial.tabs[0].id, second: "old-two", empty: null });
  assert.deepEqual(saved.at(-1).tabs, partial.tabs);
  assert.deepEqual(saved.at(-1).views, partial.views);
  assert.equal(saved.at(-1).control.recoveryRequired, true);
  await assert.rejects(broker.dispatch({ method: "return", sessionId: 7, clientId: "this-device", epoch: partial.control.epoch }), { code: "recovery_required" });
  const restored = await restore();
  assert.equal(restored.tabs.length, 2);
  assert.equal(restored.tabs[0].id, partial.tabs[0].id);
  assert.deepEqual(navigated.map((entry) => entry.url), ["https://example.com/one", "https://example.com/two"]);
  assert.deepEqual(restored.views, { first: restored.tabs[0].id, alsoFirst: restored.tabs[0].id, second: restored.tabs[1].id, empty: null });
  assert.equal(restored.control.owner, "this-device");
  assert.equal(restored.control.recoveryRequired, false);
  assert.equal(spaces[0].ownership, "agentDelegatedToUser");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(agentResumed, false);
  await broker.dispatch({ method: "return", sessionId: 7, clientId: "this-device", epoch: restored.control.epoch });
  const listed = await pending;
  assert.equal(agentResumed, true);
  assert.deepEqual(listed.tabs.map((tab) => tab.tabId), restored.tabs.map((tab) => tab.id));
});

test("恢复页创建后导航失败保留原 URL 和 view，重试复用 target 且保持人工暂停", async (context) => {
  const { broker, group, spaces, targets, saved, navigated, faults } = recoveryFixture();
  faults.failNavigateAt = 2;
  let agentResumed = false;
  const pending = broker.dispatch({ method: "agent", sessionId: 7, kind: "list" }).then((result) => {
    agentResumed = true;
    return result;
  });
  pending.catch(() => {});
  context.after(() => group.control.stop());
  const restore = () => broker.dispatch({ method: "restore", sessionId: 7, clientId: "this-device", epoch: group.control.epoch });
  await assert.rejects(restore(), /页面导航失败/);
  const partial = await broker.dispatch({ method: "session", sessionId: 7 });
  assert.equal(partial.tabs.length, 2);
  assert.equal(partial.tabs[1].id, "old-two");
  assert.equal(partial.tabs[1].url, "https://example.com/two");
  assert.equal(partial.tabs[1].live, false);
  assert.deepEqual(partial.views, { first: partial.tabs[0].id, alsoFirst: partial.tabs[0].id, second: "old-two", empty: null });
  assert.equal(partial.control.owner, "this-device");
  assert.equal(partial.control.recoveryRequired, true);
  assert.equal(spaces[0].ownership, "agentDelegatedToUser");
  const createdIds = [...targets.keys()].filter((targetId) => targetId !== group.anchorId);
  assert.equal(createdIds.length, 2);
  const unfinishedId = createdIds.find((targetId) => targetId !== partial.tabs[0].id);
  // 失败页仍可能上报 about:blank；恢复地址必须继续来自旧记录。
  await broker.event({
    method: "Target.targetInfoChanged",
    params: { targetInfo: { ...targets.get(unfinishedId), title: "" } },
  });
  faults.failNavigateAt = faults.navigationAttempts + 1;
  await assert.rejects(restore(), /页面导航失败/);
  const retried = await broker.dispatch({ method: "session", sessionId: 7 });
  assert.deepEqual(retried.tabs, partial.tabs);
  assert.deepEqual(retried.views, partial.views);
  assert.deepEqual([...targets.keys()].filter((targetId) => targetId !== group.anchorId), createdIds);
  assert.equal(faults.openAttempts, 2);
  assert.deepEqual(saved.at(-1).tabs, retried.tabs);
  assert.deepEqual(saved.at(-1).views, retried.views);
  assert.equal(saved.at(-1).control.recoveryRequired, true);
  await assert.rejects(broker.dispatch({ method: "return", sessionId: 7, clientId: "this-device", epoch: retried.control.epoch }), { code: "recovery_required" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(agentResumed, false);
  const restored = await restore();
  assert.deepEqual(restored.tabs.map((tab) => tab.id), [partial.tabs[0].id, unfinishedId]);
  assert.deepEqual(restored.tabs.map((tab) => tab.url), ["https://example.com/one", "https://example.com/two"]);
  assert.deepEqual(restored.views, { first: restored.tabs[0].id, alsoFirst: restored.tabs[0].id, second: unfinishedId, empty: null });
  assert.deepEqual(navigated.map((entry) => entry.url), ["https://example.com/one", "https://example.com/two"]);
  assert.equal(faults.openAttempts, 2);
  assert.deepEqual([...targets.keys()].filter((targetId) => targetId !== group.anchorId), createdIds);
  assert.equal(restored.control.owner, "this-device");
  assert.equal(restored.control.recoveryRequired, false);
  assert.equal(spaces[0].ownership, "agentDelegatedToUser");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(agentResumed, false);
  await broker.dispatch({ method: "return", sessionId: 7, clientId: "this-device", epoch: restored.control.epoch });
  const listed = await pending;
  assert.equal(agentResumed, true);
  assert.deepEqual(listed.tabs.map((tab) => tab.tabId), restored.tabs.map((tab) => tab.id));
});

test("恢复页创建成功但进度保存失败时，重试复用页面和 view 映射", async () => {
  const { broker, group, navigated, faults } = recoveryFixture();
  faults.failSaveOnce = true;
  const restore = () => broker.dispatch({ method: "restore", sessionId: 7, clientId: "this-device", epoch: group.control.epoch });
  await assert.rejects(restore(), /会话记录写入失败/);
  const partial = await broker.dispatch({ method: "session", sessionId: 7 });
  assert.equal(partial.tabs.length, 2);
  assert.equal(partial.views.first, partial.tabs[0].id);
  assert.equal(partial.control.recoveryRequired, true);
  assert.equal(partial.control.owner, "this-device");
  const restored = await restore();
  assert.equal(restored.tabs[0].id, partial.tabs[0].id);
  assert.deepEqual(navigated.map((entry) => entry.url), ["https://example.com/one", "https://example.com/two"]);
});

test("恢复确认保存失败仍保留人工暂停和恢复要求，再次确认不重建页面", async () => {
  const { broker, group, spaces, saved, navigated, faults } = recoveryFixture();
  faults.failConfirmationSaveOnce = true;
  const restore = () => broker.dispatch({ method: "restore", sessionId: 7, clientId: "this-device", epoch: group.control.epoch });
  await assert.rejects(restore(), /会话记录写入失败/);
  const partial = await broker.dispatch({ method: "session", sessionId: 7 });
  assert.equal(partial.control.recoveryRequired, true);
  assert.equal(partial.control.owner, "this-device");
  assert.equal(spaces[0].ownership, "agentDelegatedToUser");
  assert.equal(saved.at(-1).control.recoveryRequired, true);
  const restored = await restore();
  assert.deepEqual(restored.tabs.map((tab) => tab.id), partial.tabs.map((tab) => tab.id));
  assert.equal(navigated.length, 2);
  assert.equal(restored.control.recoveryRequired, false);
});

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

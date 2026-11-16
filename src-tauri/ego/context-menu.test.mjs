import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { contextCaptureSource, dispatchContextMenu, dispatchSelectWord } from "./context-menu.mjs";

test("长按选词在隔离上下文读取，不产生整页双击、不激活窗口", async () => {
  const commands = [];
  const call = async (_page, method, params) => {
    commands.push({ method, params });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 9 };
    return { result: { value: { handled: false, selection: "浏览器", linkUrl: "https://example.com/", editable: false } } };
  };
  assert.equal((await dispatchSelectWord(call, {}, { x: 10, y: 20 })).selection, "浏览器");
  assert.equal(commands.find(command => command.method === "Runtime.evaluate").params.contextId, 9);
  assert.equal(commands.some(command => /Input\.|activate|bringToFront/i.test(command.method)), false);
});

test("选词失败或未支持的内嵌页明确报错，不伪造空选区成功", async () => {
  for (const result of [{ exceptionDetails: {} }, {}, { result: { value: { unsupported: true } } }]) {
    const call = async (_page, method) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 9 };
      return result;
    };
    await assert.rejects(dispatchSelectWord(call, {}, { x: 10, y: 20 }));
  }
});

test("输入框只单击定位光标，再按词界设置真实选区，不使用不稳定的后台双击", async () => {
  const commands = [];
  let evaluation = 0;
  const call = async (_page, method, params) => {
    commands.push({ method, params });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 9 };
    if (method === "Runtime.evaluate") return { result: { value: ++evaluation === 1 ? { input: true, editable: true, linkUrl: null } : "mobile" } };
    return {};
  };
  assert.equal((await dispatchSelectWord(call, {}, { x: 10, y: 20 })).selection, "mobile");
  const inputs = commands.filter(command => command.method === "Input.dispatchMouseEvent");
  assert.deepEqual(inputs.map(command => command.params.type), ["mousePressed", "mouseReleased"]);
  assert.equal(inputs.every(command => command.params.clickCount === 1), true);
  assert.match(commands.at(-1).params.expression, /setSelectionRange/);
});

test("网页没有接管右键时阻止不可见的原生菜单，并返回链接和选区", () => {
  let listener;
  class Element {
    closest(selector) { return selector === "a[href]" ? { href: "https://example.com/" } : null; }
  }
  const environment = { Element, HTMLInputElement: class {}, HTMLTextAreaElement: class {},
    getSelection: () => ({ toString: () => "已选择文字" }),
    addEventListener: (_type, callback) => { listener = callback; } };
  const context = vm.createContext(environment);
  vm.runInContext(contextCaptureSource, context);
  let prevented = false;
  listener({ target: new Element(), composedPath: () => [], defaultPrevented: false,
    preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(environment.__codegContextMenu.value.handled, false);
  assert.equal(environment.__codegContextMenu.value.linkUrl, "https://example.com/");
  assert.equal(environment.__codegContextMenu.value.selection, "已选择文字");
  prevented = false;
  listener({ target: new Element(), composedPath: () => [], defaultPrevented: false,
    preventDefault() { prevented = true; } });
  assert.equal(prevented, false, "后续日常原生右键不被 Web 监听器拦截");
});

test("网页已自定义右键菜单时不显示替代菜单，密码字段不读取选中文字", () => {
  let listener;
  class Element { closest() { return null; } }
  class Input extends Element { type = "password"; value = "not-for-clipboard"; selectionStart = 0; selectionEnd = 17; }
  const environment = { Element, HTMLInputElement: Input, HTMLTextAreaElement: class {},
    getSelection: () => ({ toString: () => "" }),
    addEventListener: (_type, callback) => { listener = callback; } };
  vm.runInNewContext(contextCaptureSource, environment);
  let prevented = false;
  listener({ target: new Input(), composedPath: () => [], defaultPrevented: true,
    preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(environment.__codegContextMenu.value.handled, true);
  assert.equal(environment.__codegContextMenu.value.selection, "");
});

test("右键在同一页面先安装监听再派发按下与释放，不调用前台激活接口", async () => {
  const commands = [];
  const call = async (_page, method, params) => {
    commands.push({ method, params });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 4 };
    if (method === "Runtime.evaluate") return { result: { value: params.expression === contextCaptureSource ? true : { handled: false, linkUrl: "https://example.com/", selection: "", editable: false } } };
    return {};
  };
  const context = await dispatchContextMenu(call, {}, { x: 20, y: 30, modifiers: 2 });
  assert.equal(context.linkUrl, "https://example.com/");
  assert.deepEqual(commands.filter(command => command.method === "Input.dispatchMouseEvent").map(command => command.params), [
    { type: "mousePressed", x: 20, y: 30, button: "right", buttons: 2, clickCount: 1, modifiers: 2 },
    { type: "mouseReleased", x: 20, y: 30, button: "right", buttons: 0, clickCount: 1, modifiers: 2 },
  ]);
  assert.equal(commands.some(command => /activate|bringToFront/i.test(command.method)), false);
});

test("右键派发失败仍解除本次拦截，避免影响执行机后续原生右键", async () => {
  const cleanup = [];
  const call = async (_page, method, params) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 4 };
    if (method === "Input.dispatchMouseEvent") throw new Error("input failed");
    if (params.expression === "globalThis.__codegContextMenu.armed = false") cleanup.push(params.contextId);
    return {};
  };
  await assert.rejects(dispatchContextMenu(call, {}, { x: 20, y: 30 }), /input failed/);
  assert.deepEqual(cleanup, [4]);
});

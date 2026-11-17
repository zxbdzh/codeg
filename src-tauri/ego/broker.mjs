import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import * as fs from "node:fs/promises";
import path from "node:path";

import { BrowserControlError, PageGroupControl } from "./control.mjs";
import { CdpConnection, validateEndpoint } from "./cdp.mjs";
import { dispatchContextMenu, dispatchSelectWord } from "./context-menu.mjs";
import { createVideoEncoder } from "./video.mjs";
import { EgoRtcConnection } from "./rtc.mjs";
import { PixelStream } from "./pixel-stream.mjs";

function fail(code, message) {
  throw new BrowserControlError(code, message);
}

function webUrl(value) {
  if (value === "about:blank") return value;
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    fail("invalid_url", "仅支持 HTTP、HTTPS 或空白页。");
  }
  return parsed.href;
}

function sessionKey(value) {
  if (!Number.isInteger(value) || value <= 0) fail("invalid_session", "请先选择已保存的会话。");
  return String(value);
}

function cleanName(value) {
  return path.basename(value || "download").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 120);
}

export class EgoBroker {
  constructor(options, native = globalThis.ego) {
    this.root = path.resolve(options.dataDir);
    this.endpoint = validateEndpoint(options.endpoint);
    this.native = native;
    this.groups = new Map();
    this.pages = new Map();
    this.downloads = new Map();
    this.closing = new Set();
    this.nativeQueue = Promise.resolve();
    this.saveQueue = Promise.resolve();
    this.lifecycleQueue = Promise.resolve();
    this.lifecycleRunId = randomUUID();
    this.lifecycleEnabled = false;
    this.agentBundlePath = options.agentBundlePath;
    this.videoEncoder = options.videoEncoder;
    this.rtcConnections = new Map();
    this.rtcFactory = options.rtcFactory ?? ((browser, input) => new EgoRtcConnection(browser, input));
    this.rtcIceServers = options.rtcIceServers ?? [];
    this.pixelCodec = options.pixelCodec;
    this.pixelStreams = new Map();
    this.agentBundle = null;
    this.disconnected = false;
  }

  async start() {
    await fs.mkdir(this.root, { recursive: true });
    this.lifecycleEnabled = true;
    await this.recordLifecycle("bridge_started");
    let saved;
    try {
      saved = JSON.parse(await fs.readFile(path.join(this.root, "sessions.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        fail("state_unreadable", "浏览器会话记录无法读取，请保留原文件后检查，避免覆盖已有页面记录。");
      }
    }
    if (saved && saved.version !== 1) fail("state_version", "浏览器会话记录版本不受支持。");
    for (const record of saved?.groups ?? []) {
      this.groups.set(sessionKey(record.sessionId), {
        ...record,
        downloads: (record.downloads ?? []).map((item) => item.state === "inProgress"
          ? { ...item, state: "interrupted" } : item),
        control: new PageGroupControl({ ...record.control, recoveryRequired: true }),
        blocked: null,
        evalRequest: null,
        visits: record.visits ?? [], views: record.views ?? {},
      });
    }
    const response = await fetch(`${this.endpoint}/json/version`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) fail("ego_unreachable", "无法读取 Ego 页面通道。");
    const version = await response.json();
    const socketUrl = new URL(version.webSocketDebuggerUrl);
    const endpoint = new URL(this.endpoint);
    if (socketUrl.protocol !== "ws:" ||
        socketUrl.hostname !== endpoint.hostname || socketUrl.port !== endpoint.port) {
      fail("invalid_endpoint", "Ego 返回的页面通道与配置地址不一致。");
    }
    this.browser = new CdpConnection(socketUrl.href);
    await this.browser.ready;
    this.browser.subscribe((event) => {
      void this.event(event).catch((error) => {
        this.lastEventError = error.message;
      });
    });
    await this.browser.call("Target.setDiscoverTargets", { discover: true });
    // default 保持 Ego 的下载目录和询问设置；只接收完成事件，不全局改写下载位置。
    await this.browser.call("Browser.setDownloadBehavior", {
      behavior: "default", eventsEnabled: true,
    });
    await this.reconcile();
    return this;
  }

  recordLifecycle(type, group = null, details = {}) {
    if (!this.lifecycleEnabled) return Promise.resolve();
    const record = {
      at: new Date().toISOString(), runId: this.lifecycleRunId, pid: process.pid, type,
      ...(group ? { sessionId: group.sessionId, spaceId: group.spaceId,
        epoch: group.control.epoch, paused: group.control.owner !== null } : {}),
    };
    // 只保留定位生命周期所需的标识和枚举，不写网址、输入内容、凭据或原始请求。
    for (const key of ["targetId", "spaceId", "role", "source", "method", "outcome", "errorCode", "reason", "explicit"]) {
      if (["string", "number", "boolean"].includes(typeof details[key])) record[key] = details[key];
    }
    const operation = this.lifecycleQueue.then(async () => {
      const filename = path.join(this.root, "lifecycle.jsonl");
      try {
        // 保留当前与上一份记录，长期运行也不会无限积累诊断文件。
        if ((await fs.stat(filename)).size >= 256 * 1024) {
          await fs.rename(filename, path.join(this.root, "lifecycle.previous.jsonl"));
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await fs.appendFile(filename, `${JSON.stringify(record)}\n`);
    });
    // 诊断写入失败不能阻止接管、关闭或保存页面状态，后续记录仍可重试。
    this.lifecycleQueue = operation.catch((error) => { this.lastLifecycleError = error.code ?? "write_failed"; });
    return this.lifecycleQueue;
  }

  async nativeCall(spaceId, method, ...args) {
    const operation = this.nativeQueue.then(async () => {
      const group = spaceId == null ? null : [...this.groups.values()].find((entry) => entry.spaceId === spaceId);
      const tracked = !["listTaskSpaces", "listTabs"].includes(method);
      if (tracked) await this.recordLifecycle("native_request", group, { spaceId, method });
      try {
        if (spaceId != null) {
          const selected = await this.native.useTaskSpace(spaceId);
          // 切组失败时不能沿用上一次的页面组执行后续操作。
          if (selected?.error_code) throw new BrowserControlError(selected.error_code, selected.error);
        }
        const result = await this.native[method](...args);
        if (result?.error_code) {
          throw new BrowserControlError(result.error_code, result.error);
        }
        if (tracked) await this.recordLifecycle("native_result", group, {
          spaceId: method === "createTaskSpace" ? result?.id : spaceId,
          method, targetId: result?.targetId, outcome: "ok",
        });
        return result;
      } catch (error) {
        await this.recordLifecycle("native_result", group, { spaceId, method, outcome: "error", errorCode: error.code });
        throw error;
      }
    });
    this.nativeQueue = operation.catch(() => {});
    return operation;
  }

  group(value) {
    const key = sessionKey(value);
    let group = this.groups.get(key);
    if (!group) {
      group = {
        sessionId: value, name: `Codeg ${value} ${randomUUID()}`,
        spaceId: null, tabs: [], downloads: [], control: new PageGroupControl(),
        blocked: null, evalRequest: null,
        visits: [], views: {},
      };
      this.groups.set(key, group);
    }
    return group;
  }

  snapshot(group) {
    group.revision = (group.revision ?? 0) + 1;
    return {
      revision: group.revision,
      sessionId: group.sessionId,
      spaceId: group.spaceId,
      tabs: group.tabs.map((tab) => ({ ...tab })),
      views: { ...group.views },
      downloads: group.downloads.map(({ path: _path, ...download }) => download),
      control: group.control.snapshot(),
      blocked: group.blocked,
      evalRequest: group.evalRequest && {
        id: group.evalRequest.id,
        code: group.evalRequest.code,
        tabId: group.evalRequest.tabId,
      },
      connected: !this.disconnected,
    };
  }

  save() {
    const operation = this.saveQueue.then(async () => {
      const temporary = path.join(this.root, `sessions.${randomUUID()}.tmp`);
      const groups = [...this.groups.values()].map((group) => ({
        revision: group.revision,
        sessionId: group.sessionId, name: group.name, spaceId: group.spaceId,
        anchorId: group.anchorId, tabs: group.tabs, downloads: group.downloads,
        visits: group.visits, views: group.views,
        control: group.control.snapshot(),
      }));
      await fs.writeFile(temporary, JSON.stringify({ version: 1, groups }), { flag: "wx" });
      await fs.rename(temporary, path.join(this.root, "sessions.json"));
    });
    this.saveQueue = operation.catch(() => {});
    return operation;
  }

  async ensureSpace(group) {
    if (group.spaceId != null) return;
    group.handedOffSpaceId = null;
    const result = await this.nativeCall(null, "createTaskSpace", group.name);
    group.spaceId = result.id;
    // 空白锚点供人工接管期间创建同组页面；不必临时恢复 Agent 的原生控制权。
    const anchor = await this.nativeCall(group.spaceId, "createTab", "about:blank");
    group.anchorId = anchor.targetId;
    await this.save();
  }

  async attach(group, tab) {
    let page = this.pages.get(tab.id);
    if (page) return page;
    const attached = await this.browser.call("Target.attachToTarget", {
      targetId: tab.id, flatten: true,
    });
    page = {
      group, tab, sessionId: attached.sessionId,
      epoch: 0, world: null, frame: null, chooser: null, dialog: null,
      console: [], frames: new Set([tab.id]),
    };
    this.pages.set(tab.id, page);
    await this.call(page, "Page.enable");
    await this.call(page, "Runtime.enable");
    await this.call(page, "Page.setInterceptFileChooserDialog", { enabled: true });
    const tree = await this.call(page, "Page.getFrameTree");
    const remember = (frame) => {
      page.frames.add(frame.frame.id);
      for (const child of frame.childFrames ?? []) remember(child);
    };
    remember(tree.frameTree);
    return page;
  }

  async call(page, method, params = {}) {
    if (method === "Page.handleJavaScriptDialog") {
      return this.browser.call(method, params, page.sessionId);
    }
    const dispatched = method.startsWith("Input.") || [
      "Page.navigate", "Page.reload", "Page.navigateToHistoryEntry", "Page.close",
    ].includes(method);
    let notify;
    const interrupted = new Promise((resolve, reject) => {
      notify = () => {
        // 触发 alert 的 CDP 动作可能等确认后才返回；先释放组内队列，确认才能到达同一页。
        if (dispatched) resolve({});
        else reject(new BrowserControlError("page_dialog", "网页正在等待确认，请通过 Codeg 处理网页提示后继续。"));
      };
    });
    if (page.dialog) {
      notify();
      return interrupted;
    }
    const unsubscribe = this.browser.subscribe((event) => {
      if (event.sessionId === page.sessionId && event.method === "Page.javascriptDialogOpening") notify();
    });
    try {
      return await Promise.race([
        this.browser.call(method, params, page.sessionId), interrupted,
      ]);
    } finally {
      unsubscribe();
    }
  }

  async page(group, tabId) {
    const tab = group.tabs.find((entry) => entry.id === tabId);
    if (!tab) fail("no_such_tab", "此页面已关闭或不属于当前会话。");
    return this.attach(group, tab);
  }

  async reconcile() {
    const { targetInfos } = await this.browser.call("Target.getTargets");
    const targets = new Map(targetInfos.map((target) => [target.targetId, target]));
    const { taskSpaces } = await this.nativeCall(null, "listTaskSpaces");
    for (const group of this.groups.values()) {
      const space = taskSpaces.find((entry) => entry.id === group.spaceId && entry.name === group.name);
      if (!space) await this.recordLifecycle("space_missing", group, { source: "reconcile" });
      for (const tab of group.tabs) {
        const target = targets.get(tab.id);
        if (!space || !target || target.openerId !== (tab.openerId ?? group.anchorId)) {
          tab.live = false;
          await this.recordLifecycle("target_unavailable", group, { targetId: tab.id, source: "reconcile" });
          continue;
        }
        tab.live = true;
        tab.url = target.url;
        tab.title = target.title;
        await this.attach(group, tab);
      }
    }
  }

  async open(group, address, replacedTabId = null, viewport = null) {
    const url = webUrl(address);
    await this.ensureSpace(group);
    const anchor = await this.attach(group, { id: group.anchorId, url: "about:blank", live: true });
    const replacedTab = group.tabs.find((entry) => entry.id === replacedTabId);
    const before = await this.browser.call("Target.getTargets");
    let target = before.targetInfos.find((entry) =>
      entry.targetId === replacedTab?.recoveryTargetId && entry.openerId === group.anchorId);
    if (!target) {
      const previous = new Set(before.targetInfos.map((entry) => entry.targetId));
      const tree = await this.call(anchor, "Page.getFrameTree");
      const world = await this.call(anchor, "Page.createIsolatedWorld", {
        frameId: tree.frameTree.frame.id, worldName: "codeg-page-open",
      });
      const opened = await this.call(anchor, "Runtime.evaluate", {
        expression: "window.open('about:blank', '_blank') !== null",
        contextId: world.executionContextId, returnByValue: true, userGesture: true,
      });
      if (!opened.result?.value) fail("open_failed", "Ego 阻止了新页面，请检查页面通道。");
      const after = await this.browser.call("Target.getTargets");
      target = after.targetInfos.find((entry) =>
        entry.openerId === group.anchorId && !previous.has(entry.targetId));
      if (!target) fail("open_failed", "Ego 尚未确认新页面，未重复创建。");
    }
    const tab = group.tabs.find((entry) => entry.id === target.targetId) ??
      this.pages.get(target.targetId)?.tab ??
      { id: target.targetId, openerId: group.anchorId, url, title: "", live: true };
    if (replacedTab) {
      // 导航成功前保留旧 URL/view，只记录候选 target；失败重试复用它，空白页事件不会覆盖恢复地址。
      replacedTab.recoveryTargetId = tab.id;
    } else if (!group.tabs.some((entry) => entry.id === tab.id)) {
      group.tabs.push(tab);
    }
    try {
      const page = await this.attach(group, tab);
      tab.url = url;
      if (viewport) await this.humanAction(group, page, { ...viewport, kind: "viewport" });
      await this.call(page, "Page.navigate", { url });
    } catch (error) {
      if (replacedTab) await this.save();
      throw error;
    }
    if (replacedTab) {
      // 成功页和全部视图映射一并替换后再保存，后续页或保存失败也不会重复恢复它。
      group.tabs = group.tabs.filter((entry) => entry.id !== tab.id)
        .map((entry) => entry.id === replacedTabId ? tab : entry);
      for (const viewId of Object.keys(group.views)) {
        if (group.views[viewId] === replacedTabId) group.views[viewId] = tab.id;
      }
      this.pages.delete(replacedTabId);
    }
    await this.save();
    return tab;
  }

  async handOff(group) {
    if (group.spaceId == null) return;
    if (group.handedOffSpaceId === group.spaceId) return;
    try {
      await this.nativeCall(group.spaceId, "handOffTaskSpace");
    } catch (error) {
      if (error.code !== "EGO_TASK_SPACE_USER_IN_CONTROL") throw error;
    }
    group.handedOffSpaceId = group.spaceId;
  }

  async takeOver(group) {
    if (group.spaceId != null) {
      group.handedOffSpaceId = null;
      await this.nativeCall(group.spaceId, "takeOverTaskSpace");
    }
  }

  async human(request) {
    const group = this.group(request.sessionId);
    // 设备尺寸同步只属于当前人工端；观看和切换本地全屏不能抢走 Agent 或其他设备的控制权。
    if (request.action.kind === "viewport" && group.control.owner !== request.clientId) {
      fail("read_only", "页面尺寸由当前接管设备控制，请先接管后再调整。");
    }
    const previousEpoch = group.control.epoch;
    let pauseSave;
    const operation = group.control.runHuman(
      request.clientId, request.epoch, async () => {
        if (pauseSave) await pauseSave;
        // 同一归属的指针和按键不改变持久状态；只在本轮控制 epoch 首次输入前保存。
        if (group.persistedHumanEpoch !== group.control.epoch) {
          await this.save();
          group.persistedHumanEpoch = group.control.epoch;
        }
        // 恢复前只允许转移人工控制权，不调用可能已经失效的原生页面组。
        if (request.action.kind === "takeover" && group.control.recoveryRequired) return;
        await this.handOff(group);
        if (request.action.kind === "takeover") return;
        if (request.action.kind === "open") {
          const opened = await this.open(group, request.action.url, null, request.action.viewport);
          if (typeof request.viewId === "string" && request.viewId.length <= 256) group.views[request.viewId] = opened.id;
          await this.handOff(group);
          return;
        }
        const page = await this.page(group, request.tabId);
        return this.humanAction(group, page, request.action, request.method === "closeView" ? "web-view" : "web-page");
      },
      { transfer: request.action.kind === "takeover" }
    );
    const acceptedEpoch = group.control.epoch;
    if (previousEpoch !== group.control.epoch) {
      // 在等待在途 Agent 结束前先持久保存人工暂停，不能为了降延迟牺牲重启安全。
      const epoch = group.control.epoch;
      pauseSave = this.save().then(() => { group.persistedHumanEpoch = epoch; });
      void pauseSave.catch(() => {});
    }
    const result = await operation;
    const menuAction = ["context", "selectWord"].includes(request.action.kind);
    if (menuAction) {
      group.control.checkEpoch(acceptedEpoch);
      group.control.checkOwner(request.clientId);
    }
    return {
      ...this.snapshot(group),
      // 选中文字只返回给本次已授权设备，不能放入广播或持久化的会话快照。
      ...(menuAction ? { contextMenu: result } : {}),
    };
  }

  async humanAction(group, page, action, source = "web-page") {
    switch (action.kind) {
      case "viewport": {
        if (!["mobile", "desktop"].includes(action.mode) ||
            !Number.isInteger(action.width) || action.width < 280 || action.width > 1920 ||
            !Number.isInteger(action.height) || action.height < 240 || action.height > 1600) {
          fail("invalid_viewport", "页面尺寸无效。");
        }
        const signature = `${action.mode}:${action.width}:${action.height}`;
        if (page.viewportSignature === signature) return;
        const mobile = action.mode === "mobile";
        if (mobile) {
          this.browserVersion ??= await this.browser.call("Browser.getVersion");
          const version = this.browserVersion.product?.split("/")[1] ?? "156.0.0.0";
          await this.call(page, "Emulation.setUserAgentOverride", {
            userAgent: `Mozilla/5.0 (Linux; Android 13; Codeg Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Mobile Safari/537.36`,
            platform: "Linux armv8l",
            userAgentMetadata: {
              brands: [{ brand: "Chromium", version: version.split(".")[0] }],
              fullVersionList: [{ brand: "Chromium", version }],
              platform: "Android", platformVersion: "13.0.0", architecture: "arm",
              model: "Codeg Mobile", mobile: true, bitness: "64",
            },
          });
        } else {
          await this.call(page, "Emulation.setUserAgentOverride", { userAgent: "" });
        }
        await this.call(page, "Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
        await this.call(page, "Emulation.setDeviceMetricsOverride", {
          width: action.width, height: action.height, deviceScaleFactor: mobile ? 2 : 1,
          mobile, screenWidth: action.width, screenHeight: action.height,
          screenOrientation: action.width >= action.height
            ? { type: "landscapePrimary", angle: 90 }
            : { type: "portraitPrimary", angle: 0 },
        });
        // 不刷新或激活源页面，保留当前表单；后续导航会使用相应移动/桌面身份。
        page.viewportSignature = signature;
        page.tab.viewport = { mode: action.mode, width: action.width, height: action.height };
        page.lastFrame = null;
        await this.save();
        return;
      }
      case "context":
      case "selectWord":
        if (!Number.isFinite(action.x) || !Number.isFinite(action.y) ||
            action.x < 0 || action.y < 0 || action.x > 20000 || action.y > 20000) {
          fail("invalid_input", "页面指针参数无效。");
        }
        return action.kind === "selectWord"
          ? dispatchSelectWord(this.call.bind(this), page, action)
          : dispatchContextMenu(this.call.bind(this), page, action);
      case "close": {
        await this.recordLifecycle("close_requested", group, { targetId: page.tab.id, source });
        this.closing.add(page.tab.id);
        try {
          // Page.close 尊重 beforeunload；Target.closeTarget 会跳过网页的离开确认。
          try { await this.call(page, "Page.close"); } catch (error) {
            if (!String(error.message).includes("closed")) throw error;
          }
          let closed = false;
          const deadline = Date.now() + 1000;
          do {
            const targets = await this.browser.call("Target.getTargets");
            closed = !targets.targetInfos.some((target) => target.targetId === page.tab.id);
            if (closed || page.dialog) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          } while (Date.now() < deadline);
          if (!closed) fail("close_failed", page.dialog ? "网页正在确认是否离开，请处理上方网页提示后继续。" : "Ego 尚未确认页面关闭，请检查真实页面后重试。");
          group.tabs = group.tabs.filter((tab) => tab.id !== page.tab.id);
          this.pages.delete(page.tab.id);
          await this.save();
        } finally {
          if (!page.dialog) this.closing.delete(page.tab.id);
        }
        return;
      }
      case "navigate":
        if (action.viewport) await this.humanAction(group, page, { ...action.viewport, kind: "viewport" });
        await this.call(page, "Page.navigate", { url: webUrl(action.url) });
        return;
      case "reload":
        await this.call(page, "Page.reload");
        return;
      case "back":
      case "forward": {
        const history = await this.call(page, "Page.getNavigationHistory");
        const entry = history.entries[history.currentIndex + (action.kind === "back" ? -1 : 1)];
        if (entry) await this.call(page, "Page.navigateToHistoryEntry", { entryId: entry.id });
        return;
      }
      case "pointer": {
        if (!Number.isFinite(action.x) || !Number.isFinite(action.y) ||
            action.x < 0 || action.y < 0 || action.x > 20000 || action.y > 20000 ||
            !["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"].includes(action.type) ||
            !["left", "right", "middle", "none"].includes(action.button ?? "none")) {
          fail("invalid_input", "页面指针参数无效。");
        }
        const buttons = (action.buttons ?? 0) & 7;
        // 兼容尚未刷新的 Web：移动时以持续按键位图为准，避免 button:none 让 Chromium 丢失拖选。
        const button = action.type === "mouseMoved"
          ? buttons & 1 ? "left" : buttons & 2 ? "right" : buttons & 4 ? "middle" : "none"
          : action.button ?? "none";
        await this.call(page, "Input.dispatchMouseEvent", {
          type: action.type, x: action.x, y: action.y,
          button, buttons,
          modifiers: (action.modifiers ?? 0) & 15,
          clickCount: action.type === "mouseMoved" || action.type === "mouseWheel" ? 0 : 1,
          ...(action.type === "mouseWheel" ? {
            deltaX: Number(action.deltaX) || 0, deltaY: Number(action.deltaY) || 0,
          } : {}),
        });
        return;
      }
      case "text":
        if (typeof action.text !== "string" || action.text.length > 100000) {
          fail("invalid_input", "页面输入内容过长或无效。");
        }
        await this.call(page, "Input.insertText", { text: action.text });
        return;
      case "key":
        if (!["keyDown", "keyUp"].includes(action.type) ||
            typeof action.key !== "string" || action.key.length > 64) {
          fail("invalid_input", "页面按键参数无效。");
        }
        await this.call(page, "Input.dispatchKeyEvent", {
          type: action.type, key: action.key, code: String(action.code ?? "").slice(0, 64),
          modifiers: (action.modifiers ?? 0) & 15,
          windowsVirtualKeyCode: Number(action.keyCode) || 0,
        });
        return;
      case "dialog":
        await this.call(page, "Page.handleJavaScriptDialog", {
          accept: action.accept === true, promptText: String(action.text ?? "").slice(0, 10000),
        });
        if (action.accept !== true) this.closing.delete(page.tab.id);
        page.dialog = null;
        return;
      case "files":
        return this.upload(page, action);
      default:
        fail("invalid_action", "不支持此页面操作。");
    }
  }

  async upload(page, action) {
    if (!page.chooser) fail("no_file_chooser", "网页当前没有待处理的文件选择。");
    if (!Array.isArray(action.files) || action.files.length > 100) {
      fail("invalid_files", "文件列表无效。");
    }
    const files = [];
    for (const selected of action.files) {
      const filename = await fs.realpath(selected.path);
      const root = await fs.realpath(selected.root);
      const relative = path.relative(root, filename);
      if (relative.startsWith("..") || path.isAbsolute(relative) ||
          !(await fs.stat(filename)).isFile()) {
        fail("invalid_files", "只能交付所选项目或上传目录内的普通文件。");
      }
      files.push(filename);
    }
    await this.call(page, "DOM.setFileInputFiles", {
      files, backendNodeId: page.chooser.backendNodeId,
    });
    page.chooser = null;
  }

  async returnToAgent(request) {
    const group = this.group(request.sessionId);
    await group.control.returnToAgent(request.clientId, request.epoch);
    group.blocked = null;
    await this.save();
    return this.snapshot(group);
  }

  async runAgent(group, operation) {
    return group.control.runAgent(async () => {
      await this.ensureSpace(group);
      const { taskSpaces } = await this.nativeCall(null, "listTaskSpaces");
      const space = taskSpaces.find((entry) => entry.id === group.spaceId && entry.name === group.name);
      if (!space) {
        await this.recordLifecycle("space_missing", group, { source: "agent" });
        group.control.recoveryRequired = true;
        group.control.nativeResumeAuthorized = false;
        group.blocked = "Ego 页面组已变化，请先在 Codeg 确认恢复。";
        // 原生组可能先于销毁事件消失，不能让旧 live 标志或 CDP 缓存跳过恢复。
        for (const tab of group.tabs) {
          tab.live = false;
          this.pages.delete(tab.id);
        }
        this.pages.delete(group.anchorId);
        await this.save();
        fail("recovery_required", group.blocked);
      }
      if (space.ownership !== "agent") {
        if (!group.control.nativeResumeAuthorized) {
          fail("user_in_control", "Ego 已由人工接管，请在 Codeg 接管后显式交还 Agent。");
        }
        await this.takeOver(group);
      }
      group.control.nativeResumeAuthorized = false;
      return operation();
    });
  }

  async evaluate(page, expression) {
    if (page.world == null) {
      const tree = await this.call(page, "Page.getFrameTree");
      const world = await this.call(page, "Page.createIsolatedWorld", {
        frameId: tree.frameTree.frame.id, worldName: "codeg-browser-agent",
      });
      if (this.agentBundle == null) this.agentBundle = await fs.readFile(this.agentBundlePath, "utf8");
      await this.call(page, "Runtime.evaluate", {
        contextId: world.executionContextId, expression: this.agentBundle,
      });
      page.world = world.executionContextId;
    }
    const result = await this.call(page, "Runtime.evaluate", {
      contextId: page.world, expression, returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) fail("browser_read_failed", result.exceptionDetails.text);
    return result.result.value;
  }

  tabSummary(tab) {
    let origin = null;
    try { origin = new URL(tab.url).origin; } catch {}
    return { tabId: tab.id, origin, level: "control", title: tab.title || undefined };
  }

  async agent(request) {
    const group = this.group(request.sessionId);
    let approval;
    if (request.kind === "eval") {
      if (typeof request.code !== "string" || !request.code.trim() || [...request.code].length > 4000) {
        fail("browser_bad_code", "请提供不超过 4000 字的页面代码。");
      }
      if (group.evalRequest) fail("browser_eval_pending", "此页面组已有代码等待确认。");
      const page = await this.page(group, request.tabId);
      approval = { controlEpoch: group.control.epoch, pageEpoch: page.epoch, tabId: page.tab.id };
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          group.evalRequest = null;
          reject(new BrowserControlError("browser_eval_timeout", "代码确认已过期，未执行。"));
        }, 5 * 60 * 1000);
        group.evalRequest = {
          id: randomUUID(), code: request.code, tabId: request.tabId,
          decide: (allow) => {
            clearTimeout(timer);
            group.evalRequest = null;
            if (allow) resolve();
            else reject(new BrowserControlError("browser_eval_denied", "用户未允许执行此段代码。"));
          },
        };
      });
    }
    return this.runAgent(group, async () => {
      if (request.kind === "list") {
        return { tabs: group.tabs.filter((tab) => tab.live).map((tab) => this.tabSummary(tab)) };
      }
      if (request.kind === "open") {
        return { tab: this.tabSummary(await this.open(group, request.url)) };
      }
      const page = await this.page(group, request.tabId);
      switch (request.kind) {
        case "eval": {
          if (approval.controlEpoch !== group.control.epoch || approval.pageEpoch !== page.epoch || approval.tabId !== page.tab.id) {
            fail("browser_eval_expired", "确认后页面或控制权已变化，请重新申请执行。");
          }
          // Agent 代码只进入页面自身世界，不能污染快照和权限校验所在的隔离世界。
          const answer = await this.call(page, "Runtime.evaluate", {
            expression: request.expression, returnByValue: true, awaitPromise: true,
          });
          if (answer.exceptionDetails) fail("browser_eval_failed", answer.exceptionDetails.text);
          return { answer: answer.result.value, url: page.tab.url };
        }
        case "snapshot":
          return this.evaluate(page, `__codegAgent.snapshot(${JSON.stringify({
            maxChars: Math.min(Math.max(request.maxChars ?? 40000, 1), 1000000), epoch: String(page.epoch),
          })})`);
        case "act": {
          const action = request.request;
          const result = await this.evaluate(page,
            `__codegAgent.act(${JSON.stringify(action.generation)}, ${JSON.stringify(action.ref ?? null)}, ${JSON.stringify(action.action)})`);
          if (!result.ok) fail(result.error === "stale-ref" ? "browser_stale_ref" : "browser_action_failed", result.detail || result.error);
          return { fidelity: "synthetic", url: result.url, ...(result.scrolled ? { scrolled: result.scrolled } : {}) };
        }
        case "navigate":
          await this.humanAction(group, page, { kind: "navigate", url: request.url });
          page.tab.url = webUrl(request.url);
          await this.save();
          return { tab: this.tabSummary(page.tab) };
        case "close":
          await this.humanAction(group, page, { kind: "close" }, "agent");
          return {};
        case "capture": {
          const options = request.request ?? {};
          let clip = null;
          if (options.ref) {
            const rectangle = await this.evaluate(page,
              `__codegAgent.rectOf(${JSON.stringify(options.generation)}, ${JSON.stringify(options.ref)})`);
            if (!rectangle.ok) fail("browser_stale_ref", rectangle.detail || "请刷新页面快照。");
            clip = { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height };
          }
          const metrics = await this.call(page, "Page.getLayoutMetrics");
          const image = await this.call(page, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
          return { data: image.data, cssWidth: metrics.cssVisualViewport.clientWidth, clip, url: page.tab.url };
        }
        case "console": {
          const query = request.query ?? {};
          const levels = ["debug", "log", "info", "warn", "error"];
          const matching = page.console.filter((entry) => entry.seq > (query.since ?? 0) &&
            levels.indexOf(entry.level) >= Math.max(0, levels.indexOf(query.minLevel)));
          const entries = matching.slice(0, Math.min(query.limit || 100, 200));
          return { url: page.tab.url, entries, dropped: page.consoleDropped ?? 0,
            nextSince: entries.at(-1)?.seq ?? query.since ?? 0, more: matching.length > entries.length };
        }
        default:
          fail("invalid_action", "不支持此 Agent 页面操作。");
      }
    });
  }

  async restore(request) {
    const group = this.group(request.sessionId);
    return group.control.enqueue(async () => {
      group.control.checkEpoch(request.epoch);
      if (!group.control.recoveryRequired) return this.snapshot(group);
      group.control.checkOwner(request.clientId);
      group.handedOffSpaceId = null;
      const { taskSpaces } = await this.nativeCall(null, "listTaskSpaces");
      const space = taskSpaces.find((entry) => entry.name === group.name);
      try {
        if (space) {
          group.spaceId = space.id;
          if (space.ownership === "agentDelegatedToUser") {
            if (group.control.owner === null) await this.takeOver(group);
          } else if (space.ownership !== "agent") {
            await this.nativeCall(null, "claimTaskSpace", space.id);
          }
        } else {
          group.spaceId = null;
          await this.ensureSpace(group);
        }
        const { targetInfos } = await this.browser.call("Target.getTargets");
        if (!targetInfos.some((target) => target.targetId === group.anchorId)) {
          if (group.control.owner !== null) await this.takeOver(group);
          const anchor = await this.nativeCall(group.spaceId, "createTab", "about:blank");
          group.anchorId = anchor.targetId;
          if (group.control.owner !== null) await this.handOff(group);
        }
        for (const tab of [...group.tabs]) {
          if (!tab.live) await this.open(group, tab.url, tab.id);
        }
        for (const tab of group.tabs) await this.attach(group, tab);
      } finally {
        // 恢复中途失败也交回原生人工控制；确认恢复不等于交还 Agent。
        if (group.control.owner !== null) await this.handOff(group);
      }
      const blocked = group.blocked;
      group.control.confirmRecovery();
      group.blocked = null;
      try {
        await this.save();
      } catch (error) {
        // 队列尚未释放；保存失败先恢复门禁，已唤醒的 Agent 仍需等待确认。
        group.control.recoveryRequired = true;
        group.blocked = blocked;
        throw error;
      }
      return this.snapshot(group);
    });
  }

  async frame(request) {
    const group = this.group(request.sessionId);
    const page = await this.page(group, request.tabId);
    if (request.metadata === true && page.screencasting && page.lastFrame) {
      return { ...page.lastFrame, data: "", chooser: page.chooser, dialog: page.dialog };
    }
    // JS 弹窗期间部分 CDP 读取会等待弹窗结束；先送出提示才能从 Web 解开阻塞。
    if (page.dialog) {
      return { ...(page.lastFrame ?? { data: "", width: 1, height: 1 }), chooser: page.chooser, dialog: page.dialog };
    }
    try {
      const metrics = await this.call(page, "Page.getLayoutMetrics");
      const screenshot = await this.call(page, "Page.captureScreenshot", {
        format: "jpeg", quality: 88, captureBeyondViewport: false,
      });
      page.lastFrame = {
        data: screenshot.data,
        width: metrics.cssVisualViewport.clientWidth,
        height: metrics.cssVisualViewport.clientHeight,
      };
    } catch (error) {
      if (!page.dialog) throw error;
    }
    return {
      ...(page.lastFrame ?? { data: "", width: 1, height: 1 }),
      chooser: page.chooser,
      dialog: page.dialog,
    };
  }

  async watchFrames(request, response) {
    const group = this.group(request.sessionId);
    group.control.checkRecovery();
    const page = await this.page(group, request.tabId);
    const captureFormat = request.captureFormat === "png" ? "png" : "jpeg";
    let pending = null;
    let blocked = false;
    let closed = false;
    const write = (frame) => {
      if (closed) return;
      if (captureFormat === "png" && frame.format && frame.format !== "png") return;
      if (blocked) { pending = frame; return; }
      blocked = !response.write(`${JSON.stringify(frame)}\n`);
    };
    const drain = () => {
      blocked = false;
      if (pending) {
        const frame = pending;
        pending = null;
        write(frame);
      }
    };
    page.frameWatchers ??= new Set();
    page.frameClosers ??= new Set();
    page.frameWatchers.add(write);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      response.off("drain", drain);
      page.frameWatchers.delete(write);
      page.frameClosers.delete(close);
      // 断开观察只停止画面通道，不关闭页面、不改变人工归属。
      if (!page.frameWatchers.size) {
        void this.call(page, "Page.stopScreencast").catch(() => {});
        page.screencasting = null;
        page.captureFormat = null;
      }
      response.end?.();
    };
    const heartbeat = setInterval(() => {
      if (!blocked && !closed) response.write("\n");
    }, 10000);
    page.frameClosers.add(close);
    response.on("drain", drain);
    response.once("close", close);
    try {
      if (!page.screencasting || (captureFormat === "png" && page.captureFormat !== "png")) {
        if (page.screencasting) await this.call(page, "Page.stopScreencast");
        page.captureFormat = captureFormat;
        page.screencasting = this.call(page, "Page.startScreencast", {
          // 保留文字细节与高分辨率画面；仍由慢端丢旧帧，避免靠积压换清晰度。
          format: captureFormat, quality: 88, maxWidth: 2560, maxHeight: 1600, everyNthFrame: 1,
        });
      }
      await page.screencasting;
      if (page.lastFrame) write({ ...page.lastFrame, chooser: page.chooser, dialog: page.dialog });
      return close;
    } catch (error) {
      close();
      throw error;
    }
  }

  async watchPixels(request, response) {
    const group = this.group(request.sessionId);
    group.control.checkRecovery();
    await this.page(group, request.tabId);
    if (typeof request.clientId !== "string" || request.clientId.length < 8 || request.clientId.length > 128 || this.pixelStreams.size >= 8) {
      fail("invalid_pixels", "画面连接参数无效或连接过多。");
    }
    const { EventEmitter } = await import("node:events");
    const observer = new EventEmitter();
    let stopFrames;
    const pixels = new PixelStream(this.pixelCodec, response, request, () => {
      stopFrames?.(); observer.emit("close"); this.pixelStreams.delete(pixels.id);
    });
    observer.write = line => { if (line.trim()) pixels.write(JSON.parse(line)); return true; };
    observer.end = () => pixels.close();
    this.pixelStreams.set(pixels.id, pixels);
    try {
      stopFrames = await this.watchFrames({ ...request, captureFormat: "png" }, observer);
      if (pixels.closed) stopFrames();
      response.on("drain", () => void pixels.flush());
      return () => pixels.close();
    } catch (error) { pixels.close(); throw error; }
  }

  pixelAck(request) {
    const stream = this.pixelStreams.get(request.streamId);
    if (!stream) fail("pixel_closed", "画面连接已经结束。");
    if (stream.binding.sessionId !== request.sessionId || stream.binding.clientId !== request.clientId || stream.binding.tabId !== request.tabId) {
      fail("read_only", "画面连接不属于当前设备、会话或页面。");
    }
    this.group(request.sessionId).control.checkRecovery();
    return { accepted: stream.acknowledge(request.revision, request.id) };
  }

  async watchVideo(request, response) {
    const group = this.group(request.sessionId);
    group.control.checkRecovery();
    await this.page(group, request.tabId);
    const encoder = await createVideoEncoder(response, { executable: this.videoEncoder });
    const observer = new (await import("node:events")).EventEmitter();
    let stopFrames;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true; stopFrames?.(); encoder.close(); observer.emit("close");
    };
    response.once("close", close);
    observer.write = line => {
      if (!line.trim()) return true;
      const frame = JSON.parse(line);
      if (frame.data) encoder.write(Buffer.from(frame.data, "base64"));
      return true;
    };
    observer.end = () => { encoder.close(); response.end(); };
    try {
      // 视频与 JPEG 观察共享同一精确 target 的采集，不能互相 stopScreencast 或改变接管状态。
      stopFrames = await this.watchFrames(request, observer);
      if (closed) stopFrames();
      response.writeHead(200, { "content-type": "video/mp4", "cache-control": "no-store" });
      response.flushHeaders();
      encoder.start();
      return close;
    } catch (error) { close(); throw error; }
  }

  async rtcOffer(request) {
    const group = this.group(request.sessionId);
    group.control.checkRecovery();
    if (typeof request.clientId !== "string" || request.clientId.length < 8 || request.clientId.length > 128 ||
        request.offer?.type !== "offer" || typeof request.offer.sdp !== "string" || request.offer.sdp.length > 100000) {
      fail("invalid_rtc", "WebRTC 协商参数无效。");
    }
    await this.page(group, request.tabId);
    if (this.rtcConnections.size >= 8) fail("rtc_busy", "实时连接较多，请关闭不用的浏览器面板后重试。");
    let connected;
    let lastSeen = Date.now();
    const input = async payload => {
      lastSeen = Date.now();
      if (payload.length > 150000) return;
      let message;
      try { message = JSON.parse(payload); } catch { return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      const id = message.id;
      if (!Number.isSafeInteger(id) || id < 0) return;
      if (message.kind === "ping") {
        return { id, result: this.snapshot(group) };
      }
      try {
        if (message.kind !== "human" || !message.action ||
            !["pointer", "text", "key", "context", "selectWord"].includes(message.action.kind)) {
          fail("invalid_rtc_input", "此操作请通过原会话接口执行。");
        }
        // 会话、设备和真实 target 由握手绑定，不能相信对端重新自报；epoch 仍逐动作验证。
        const result = await this.human({ method: "human", sessionId: request.sessionId,
          clientId: request.clientId, viewId: request.viewId, tabId: request.tabId,
          epoch: message.epoch, action: message.action });
        return { id, result };
      } catch (error) {
        return { id, error: { code: error.code ?? "rtc_input_failed", message: error.message } };
      }
    };
    const rtc = this.rtcFactory(this.browser, input);
    const { EventEmitter } = await import("node:events");
    const observer = new EventEmitter();
    observer.write = line => {
      if (line.trim()) rtc.write(JSON.parse(line));
      return true;
    };
    observer.end = () => { void rtc.close(); };
    let stopFrames;
    let timer;
    rtc.onClose = () => {
      clearInterval(timer);
      stopFrames?.();
      observer.emit("close");
      this.rtcConnections.delete(rtc.id);
    };
    this.rtcConnections.set(rtc.id, { rtc, sessionId: request.sessionId, clientId: request.clientId });
    try {
      connected = await rtc.start(request.offer, this.rtcIceServers);
      group.control.checkRecovery();
      if (!group.tabs.some(tab => tab.id === request.tabId && tab.live)) fail("no_such_tab", "原页面已关闭。");
      stopFrames = await this.watchFrames(request, observer);
      if (rtc.closed) { stopFrames(); fail("rtc_closed", "实时通道已结束。"); }
      timer = setInterval(() => {
        if (Date.now() - lastSeen > 15000 || this.disconnected || group.control.recoveryRequired) void rtc.close();
      }, 3000);
      return connected;
    } catch (error) { await rtc.close(); throw error; }
  }

  async rtcClose(request) {
    const entry = this.rtcConnections.get(request.id);
    if (!entry) return { closed: true };
    if (entry.sessionId !== request.sessionId || entry.clientId !== request.clientId) {
      fail("read_only", "实时连接不属于当前设备或会话。");
    }
    await entry.rtc.close();
    return { closed: true };
  }

  async event(event) {
    if (event.method === "Page.screencastFrame") {
      const page = [...this.pages.values()].find((entry) => entry.sessionId === event.sessionId);
      if (!page) return;
      // 立即确认给 Ego；慢设备只保留最新帧，绝不让过时画面排队拖慢输入。
      void this.browser.call("Page.screencastFrameAck", { sessionId: event.params.sessionId }, page.sessionId).catch(() => {});
      const metadata = event.params.metadata;
      page.lastFrame = { data: event.params.data, width: metadata.deviceWidth, height: metadata.deviceHeight, format: page.captureFormat ?? "jpeg" };
      for (const watcher of page.frameWatchers ?? []) {
        watcher({ ...page.lastFrame, chooser: page.chooser, dialog: page.dialog });
      }
      return;
    }
    if (["Target.targetDestroyed", "Target.targetCrashed", "Inspector.targetCrashed"].includes(event.method)) {
      const targetId = event.params?.targetId ??
        [...this.pages.values()].find((page) => page.sessionId === event.sessionId)?.tab.id;
      const group = targetId && [...this.groups.values()].find((entry) => entry.anchorId === targetId ||
        entry.tabs.some((tab) => tab.id === targetId || tab.recoveryTargetId === targetId));
      if (group) {
        // CDP 只报告结果，不能据此认定发起方；与关闭意图、原生操作记录共同核对。
        void this.recordLifecycle("target_event", group, {
          targetId, method: event.method, role: group.anchorId === targetId ? "anchor" : "page",
          explicit: this.closing.has(targetId), errorCode: event.params?.errorCode,
        });
      }
    }
    if (event.method === "Codeg.disconnected") {
      void this.recordLifecycle("cdp_disconnected", null, { explicit: this.stopping === true });
      this.disconnected = true;
      for (const page of this.pages.values()) {
        for (const close of [...page.frameClosers ?? []]) close();
      }
      for (const group of this.groups.values()) {
        group.control.stop();
        group.evalRequest?.decide(false);
        group.blocked = "Ego 已断开；恢复后需要确认，未完成动作不会自动重放。";
      }
      await this.save();
      return;
    }
    if (event.method === "Target.targetInfoChanged") {
      const target = event.params.targetInfo;
      const page = this.pages.get(target.targetId);
      if (page) {
        page.tab.url = target.url;
        page.tab.title = target.title;
        await this.save();
      }
      return;
    }
    if (event.method === "Target.targetDestroyed") {
      const destroyed = this.pages.get(event.params.targetId);
      for (const close of [...destroyed?.frameClosers ?? []]) close();
      if (this.closing.delete(event.params.targetId)) {
        const page = this.pages.get(event.params.targetId);
        if (page) page.group.tabs = page.group.tabs.filter((tab) => tab.id !== event.params.targetId);
        this.pages.delete(event.params.targetId);
        await this.save();
        return;
      }
      for (const group of this.groups.values()) {
        // 关闭 Codeg 标签会显式移除；Ego 退出产生的销毁事件只标记离线，保留恢复地址。
        const tab = group.tabs.find((entry) => entry.id === event.params.targetId);
        if (tab) {
          tab.live = false;
          group.control.recoveryRequired = true;
          group.blocked = "Ego 页面已离线，请确认恢复；未自动重建页面。";
        }
      }
      this.pages.delete(event.params.targetId);
      await this.save();
      return;
    }
    if (event.method === "Target.targetCreated") {
      const target = event.params.targetInfo;
      const opener = this.pages.get(target.openerId);
      if (opener && target.type === "page" && opener.tab.id !== opener.group.anchorId &&
          !opener.group.tabs.some((tab) => tab.id === target.targetId)) {
        const tab = { id: target.targetId, openerId: target.openerId, url: target.url, title: target.title, live: true };
        opener.group.tabs.push(tab);
        await this.attach(opener.group, tab);
        await this.save();
      }
      return;
    }
    if (event.method === "Browser.downloadWillBegin") {
      const page = [...this.pages.values()].find((entry) => entry.frames.has(event.params.frameId));
      if (!page) return;
      const item = {
        id: event.params.guid, name: cleanName(event.params.suggestedFilename),
        state: "inProgress", bytes: 0, total: 0, path: null,
      };
      page.group.downloads.push(item);
      this.downloads.set(item.id, { group: page.group, item });
      await this.save();
      return;
    }
    if (event.method === "Browser.downloadProgress") {
      const download = this.downloads.get(event.params.guid);
      if (!download) return;
      const { group, item } = download;
      item.bytes = event.params.receivedBytes;
      item.total = event.params.totalBytes;
      if (event.params.state === "completed") {
        if (!event.params.filePath) {
          item.state = "pathUnavailable";
          group.blocked = "Ego 已完成下载，但未提供文件路径，暂时无法从 Web 取回。";
        } else {
          const directory = path.join(this.root, "downloads", String(group.sessionId));
          await fs.mkdir(directory, { recursive: true });
          item.path = path.join(directory, `${item.id}-${item.name}`);
          await fs.copyFile(event.params.filePath, item.path);
          item.state = "completed";
        }
      } else if (event.params.state === "canceled") {
        item.state = "canceled";
      }
      await this.save();
      return;
    }
    const page = [...this.pages.values()].find((entry) => entry.sessionId === event.sessionId);
    if (!page) return;
    switch (event.method) {
      case "Page.frameNavigated":
      case "Page.navigatedWithinDocument":
        page.epoch += 1;
        if (event.method === "Page.frameNavigated") {
          page.frames.add(event.params.frame.id);
          if (!event.params.frame.parentId) page.world = null;
        }
        break;
      case "Page.fileChooserOpened":
        page.chooser = event.params;
        for (const watcher of page.frameWatchers ?? []) {
          if (page.lastFrame) watcher({ ...page.lastFrame, chooser: page.chooser, dialog: page.dialog });
        }
        break;
      case "Page.javascriptDialogOpening":
        page.dialog = event.params;
        for (const watcher of page.frameWatchers ?? []) {
          if (page.lastFrame) watcher({ ...page.lastFrame, chooser: page.chooser, dialog: page.dialog });
        }
        break;
      case "Page.javascriptDialogClosed":
        page.dialog = null;
        break;
      case "Runtime.consoleAPICalled":
        page.consoleSeq = (page.consoleSeq ?? 0) + 1;
        page.console.push({
          seq: page.consoleSeq, level: event.params.type === "warning" ? "warn" : event.params.type,
          at: Math.round(event.params.timestamp), source: "console", top: true,
          text: event.params.args.slice(0, 32).map((entry) =>
            String(entry.value ?? entry.description ?? "").slice(0, 1024)).join(" ").slice(0, 4096),
        });
        if (page.console.length > 200) {
          page.console.shift();
          page.consoleDropped = (page.consoleDropped ?? 0) + 1;
        }
        break;
      default:
        break;
    }
  }

  async dispatch(request) {
    switch (request.method) {
      case "session":
        return this.snapshot(this.group(request.sessionId));
      case "rtcOffer":
        return this.rtcOffer(request);
      case "rtcClose":
        return this.rtcClose(request);
      case "pixelAck":
        return this.pixelAck(request);
      case "visit": {
        const group = this.group(request.sessionId);
        if (typeof request.viewId !== "string" || request.viewId.length > 256) fail("invalid_view", "页面视图标识无效。");
        if (Object.hasOwn(group.views, request.viewId)) return this.snapshot(group);
        const existing = group.tabs.find((tab) => tab.url === request.url) ??
          (request.url === "about:blank" ? group.tabs[0] : null);
        if (existing || request.url === "about:blank" || group.visits.includes(request.viewId)) {
          group.views[request.viewId] = existing?.id ?? null;
          await this.save();
          return this.snapshot(group);
        }
        const operation = group.control.runHuman(request.clientId, request.epoch, async () => {
          await this.handOff(group);
          // 同一视图重连复用真实 target；已关闭的映射保留为空，避免刷新复活页面。
          if (!Object.hasOwn(group.views, request.viewId)) {
            const opened = await this.open(group, request.url, null, request.viewport);
            await this.handOff(group);
            group.views[request.viewId] = opened.id;
            group.visits.push(request.viewId);
          }
        });
        await this.save();
        await operation;
        await this.save();
        return this.snapshot(group);
      }
      case "view": {
        const group = this.group(request.sessionId);
        if (typeof request.viewId !== "string" || request.viewId.length > 256) fail("invalid_view", "页面视图标识无效。");
        if (!group.tabs.some((tab) => tab.id === request.tabId)) fail("no_such_tab", "此页面已关闭或不属于当前会话。");
        group.views[request.viewId] = request.tabId;
        await this.save();
        return this.snapshot(group);
      }
      case "closeView": {
        const group = this.group(request.sessionId);
        const tabId = group.views[request.viewId];
        if (!tabId || !group.tabs.some((tab) => tab.id === tabId)) return this.snapshot(group);
        return this.human({ ...request, tabId, action: { kind: "close" } });
      }
      case "human":
        return this.human(request);
      case "return":
        return this.returnToAgent(request);
      case "restore":
        return this.restore(request);
      case "frame":
        return this.frame(request);
      case "evalDecision": {
        const group = this.group(request.sessionId);
        group.control.checkEpoch(request.epoch);
        group.control.checkOwner(request.clientId);
        if (group.evalRequest?.id !== request.id) fail("browser_eval_expired", "代码确认已过期。");
        group.evalRequest.decide(request.allow === true);
        return this.snapshot(group);
      }
      case "health":
        return { connected: !this.disconnected };
      case "agent":
        return this.agent(request);
      case "download": {
        const group = this.group(request.sessionId);
        const item = group.downloads.find((entry) =>
          entry.id === request.downloadId && entry.state === "completed");
        if (!item) fail("download_unavailable", "文件尚未完成下载或不属于此会话。");
        return { path: item.path, name: item.name };
      }
      default:
        fail("invalid_method", "不支持此浏览器请求。");
    }
  }
}

export async function serve(options) {
  if (typeof options.token !== "string" || options.token.length < 32) {
    fail("invalid_token", "浏览器桥接凭据未配置。");
  }
  const broker = await new EgoBroker(options).start();
  const expected = Buffer.from(`Bearer ${options.token}`);
  const server = createServer(async (request, response) => {
    const received = Buffer.from(request.headers.authorization ?? "");
    if (request.method !== "POST" || received.length !== expected.length ||
        !timingSafeEqual(received, expected)) {
      response.writeHead(401).end();
      return;
    }
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) fail("body_too_large", "浏览器请求过大。");
        chunks.push(chunk);
      }
      const command = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (command.method === "stream") {
        // 凭据沿用同一个回环桥接；外层服务负责鉴权、项目归属和流式转发。
        broker.group(command.sessionId).control.checkRecovery();
        await broker.page(broker.group(command.sessionId), command.tabId);
        if (command.format === "pixels") {
          if (!broker.pixelCodec) fail("pixels_unavailable", "当前环境未配置无损显示。");
          response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
          response.flushHeaders();
          await broker.watchPixels(command, response);
          return;
        }
        if (command.format === "video") {
          await broker.watchVideo(command, response);
          return;
        }
        response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
        response.flushHeaders();
        await broker.watchFrames(command, response);
        return;
      }
      const result = command.method === "shutdown" ? { stopped: true } : await broker.dispatch(command);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ result }));
      if (command.method === "shutdown") shutdown("rpc");
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: { code: error.code ?? "ego_failed", message: error.message },
      }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  console.log(`CODEG_EGO_READY=${JSON.stringify({ port: server.address().port })}`);
  if (options.readyPath) {
    await fs.writeFile(options.readyPath, JSON.stringify({ port: server.address().port }), { flag: "wx" });
  }
  let leaseTimer;
  let rtcShutdown;
  const closeRtcTargets = () => {
    for (const pixels of [...broker.pixelStreams.values()]) pixels.close();
    rtcShutdown ??= Promise.allSettled([...broker.rtcConnections.values()].map(({ rtc }) => rtc.close()));
    return rtcShutdown;
  };
  function shutdown(reason) {
    clearInterval(leaseTimer);
    broker.stopping = true;
    void broker.recordLifecycle("bridge_stop_requested", null, { reason });
    for (const group of broker.groups.values()) {
      group.control.stop();
      group.evalRequest?.decide(false);
    }
    // 先终止等待交还的请求，否则 server.close 会一直等待这些连接，留下孤儿桥接。
    void closeRtcTargets().finally(() => broker.browser.close());
    server.close();
    server.closeAllConnections();
  }
  if (options.leasePath) {
    // Codeg 退出后自行结束此桥接，不关闭 Ego 或任何保留页面。
    leaseTimer = setInterval(async () => {
      try {
        const lease = await fs.stat(options.leasePath);
        if (Date.now() - lease.mtimeMs < 15000) return;
      } catch {}
      shutdown("lease_expired");
    }, 3000);
  }
  server.on("close", () => {
    clearInterval(leaseTimer);
    void closeRtcTargets().finally(() => broker.browser.close());
  });
  return { server, broker };
}

import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import * as fs from "node:fs/promises";
import path from "node:path";

import { BrowserControlError, PageGroupControl } from "./control.mjs";
import { CdpConnection, validateEndpoint } from "./cdp.mjs";

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
    this.agentBundlePath = options.agentBundlePath;
    this.agentBundle = null;
    this.disconnected = false;
  }

  async start() {
    await fs.mkdir(this.root, { recursive: true });
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

  async nativeCall(spaceId, method, ...args) {
    const operation = this.nativeQueue.then(async () => {
      if (spaceId != null) await this.native.useTaskSpace(spaceId);
      const result = await this.native[method](...args);
      if (result?.error_code) {
        throw new BrowserControlError(result.error_code, result.error);
      }
      return result;
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
      for (const tab of group.tabs) {
        const target = targets.get(tab.id);
        if (!space || !target || target.openerId !== (tab.openerId ?? group.anchorId)) {
          tab.live = false;
          continue;
        }
        tab.live = true;
        tab.url = target.url;
        tab.title = target.title;
        await this.attach(group, tab);
      }
    }
  }

  async open(group, address) {
    const url = webUrl(address);
    await this.ensureSpace(group);
    const anchor = await this.attach(group, { id: group.anchorId, url: "about:blank", live: true });
    const before = await this.browser.call("Target.getTargets");
    const previous = new Set(before.targetInfos.map((target) => target.targetId));
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
    const target = after.targetInfos.find((entry) =>
      entry.openerId === group.anchorId && !previous.has(entry.targetId));
    if (!target) fail("open_failed", "Ego 尚未确认新页面，未重复创建。");
    const tab = group.tabs.find((entry) => entry.id === target.targetId) ??
      { id: target.targetId, openerId: group.anchorId, url, title: "", live: true };
    if (!group.tabs.some((entry) => entry.id === tab.id)) group.tabs.push(tab);
    const page = await this.attach(group, tab);
    await this.call(page, "Page.navigate", { url });
    await this.save();
    return tab;
  }

  async handOff(group) {
    if (group.spaceId == null) return;
    try {
      await this.nativeCall(group.spaceId, "handOffTaskSpace");
    } catch (error) {
      if (error.code !== "EGO_TASK_SPACE_USER_IN_CONTROL") throw error;
    }
  }

  async takeOver(group) {
    if (group.spaceId != null) {
      await this.nativeCall(group.spaceId, "takeOverTaskSpace");
    }
  }

  async human(request) {
    const group = this.group(request.sessionId);
    const operation = group.control.runHuman(
      request.clientId, request.epoch, async () => {
        await this.save();
        // 恢复前只允许转移人工控制权，不调用可能已经失效的原生页面组。
        if (request.action.kind === "takeover" && group.control.recoveryRequired) return;
        await this.handOff(group);
        if (request.action.kind === "takeover") return;
        if (request.action.kind === "open") {
          const opened = await this.open(group, request.action.url);
          if (typeof request.viewId === "string" && request.viewId.length <= 256) group.views[request.viewId] = opened.id;
          await this.handOff(group);
          return;
        }
        const page = await this.page(group, request.tabId);
        return this.humanAction(group, page, request.action);
      },
      { transfer: request.action.kind === "takeover" }
    );
    await this.save();
    await operation;
    return this.snapshot(group);
  }

  async humanAction(group, page, action) {
    switch (action.kind) {
      case "close": {
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
        await this.call(page, "Input.dispatchMouseEvent", {
          type: action.type, x: action.x, y: action.y,
          button: action.button ?? "none",
          buttons: (action.buttons ?? 0) & 7,
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
      if (!space) fail("recovery_required", "Ego 页面组已变化，请先在 Codeg 确认恢复。");
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
          await this.humanAction(group, page, { kind: "close" });
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
    const { taskSpaces } = await this.nativeCall(null, "listTaskSpaces");
    const space = taskSpaces.find((entry) => entry.name === group.name);
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
    const restored = [];
    for (const tab of [...group.tabs]) {
      if (tab.live) { restored.push(tab); continue; }
      const opened = await this.open(group, tab.url);
      restored.push(opened);
      for (const viewId of Object.keys(group.views)) {
        if (group.views[viewId] === tab.id) group.views[viewId] = opened.id;
      }
    }
    group.tabs = restored;
    for (const tab of restored) await this.attach(group, tab);
    if (group.control.owner !== null) await this.handOff(group);
    group.control.confirmRecovery();
    group.blocked = null;
    await this.save();
    return this.snapshot(group);
    });
  }

  async frame(request) {
    const group = this.group(request.sessionId);
    const page = await this.page(group, request.tabId);
    // JS 弹窗期间部分 CDP 读取会等待弹窗结束；先送出提示才能从 Web 解开阻塞。
    if (page.dialog) {
      return { ...(page.lastFrame ?? { data: "", width: 1, height: 1 }), chooser: page.chooser, dialog: page.dialog };
    }
    try {
      const metrics = await this.call(page, "Page.getLayoutMetrics");
      const screenshot = await this.call(page, "Page.captureScreenshot", {
        format: "jpeg", quality: 75, captureBeyondViewport: false,
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

  async event(event) {
    if (event.method === "Codeg.disconnected") {
      this.disconnected = true;
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
        break;
      case "Page.javascriptDialogOpening":
        page.dialog = event.params;
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
            const opened = await this.open(group, request.url);
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
      const result = command.method === "shutdown" ? { stopped: true } : await broker.dispatch(command);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ result }));
      if (command.method === "shutdown") shutdown();
    } catch (error) {
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
  function shutdown() {
    clearInterval(leaseTimer);
    for (const group of broker.groups.values()) {
      group.control.stop();
      group.evalRequest?.decide(false);
    }
    // 先终止等待交还的请求，否则 server.close 会一直等待这些连接，留下孤儿桥接。
    broker.browser.close();
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
      shutdown();
    }, 3000);
  }
  server.on("close", () => {
    clearInterval(leaseTimer);
    broker.browser.close();
  });
  return { server, broker };
}

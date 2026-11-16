export const contextCaptureSource = `(() => {
  const state = globalThis.__codegContextMenu ??= { value: null };
  state.value = null;
  state.armed = true;
  if (state.installed) return true;
  state.installed = true;
  addEventListener("contextmenu", event => {
    if (!state.armed) return;
    state.armed = false;
    const target = event.composedPath().find(node => node instanceof Element) ?? event.target;
    const link = target instanceof Element ? target.closest("a[href]") : null;
    const input = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    const secret = input && target.type === "password";
    let selection = secret ? "" : String(getSelection() ?? "");
    if (input && !secret && target.selectionStart != null)
      selection = target.value.slice(target.selectionStart, target.selectionEnd);
    state.value = {
      handled: event.defaultPrevented,
      linkUrl: link?.href ?? null,
      selection: selection.slice(0, 100000),
      editable: input ? !target.disabled && !target.readOnly : !!target?.isContentEditable,
    };
    // 网页自己的菜单优先；没有接管时才阻止不会出现在页面画面中的浏览器原生菜单。
    if (!event.defaultPrevented) event.preventDefault();
  });
  return true;
})()`;

export async function dispatchContextMenu(call, page, action) {
  const tree = await call(page, "Page.getFrameTree");
  const frames = [];
  const visit = node => {
    frames.push(node.frame.id);
    for (const child of node.childFrames ?? []) visit(child);
  };
  visit(tree.frameTree);
  const contexts = [];
  for (const frameId of frames.slice(0, 32)) {
    try {
      const world = await call(page, "Page.createIsolatedWorld", {
        frameId, worldName: "codeg-context-menu",
      });
      await call(page, "Runtime.evaluate", {
        contextId: world.executionContextId, expression: contextCaptureSource,
      });
      contexts.push(world.executionContextId);
    } catch (error) {
      if (frameId === frames[0]) throw error;
      // 跨进程子框架可能在另一个 CDP target；不能伪称已经拿到它的链接或选区。
    }
  }
  try {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await call(page, "Input.dispatchMouseEvent", {
        type, x: action.x, y: action.y, button: "right",
        buttons: type === "mousePressed" ? 2 : 0, clickCount: 1,
        modifiers: (action.modifiers ?? 0) & 15,
      });
    }
    for (const contextId of contexts) {
      const response = await call(page, "Runtime.evaluate", {
        contextId, expression: "globalThis.__codegContextMenu.value", returnByValue: true,
      });
      if (response.result?.value) return response.result.value;
    }
    return { handled: true, linkUrl: null, selection: "", editable: false };
  } finally {
    // 页面原生右键仍归用户所有，Web 事件结束或失败后立即撤销本次拦截。
    for (const contextId of contexts) {
      await call(page, "Runtime.evaluate", {
        contextId, expression: "globalThis.__codegContextMenu.armed = false",
      }).catch(() => {});
    }
  }
}

export const selectWordSource = `async ({ x, y }) => {
  let target = document.elementFromPoint(x, y);
  const roots = [];
  while (target?.shadowRoot) {
    roots.push(target.shadowRoot);
    const inner = target.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === target) break;
    target = inner;
  }
  const empty = { handled: false, linkUrl: null, selection: "", editable: false };
  if (!target) return empty;
  // 内嵌页需要独立坐标与上下文；未打通前不读取、不假造成功，也不点击链接。
  if (target instanceof HTMLIFrameElement) {
    return { ...empty, unsupported: true };
  }
  const input = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
  if (input && target instanceof HTMLInputElement && !["text", "search", "url", "tel", "email"].includes(target.type)) return empty;
  const details = {
    ...empty, linkUrl: target.closest("a[href]")?.href ?? null,
    editable: input ? !target.disabled && !target.readOnly : target.isContentEditable,
  };
  if (getComputedStyle(target).userSelect === "none" || (input && target.disabled)) return details;
  if (input) {
    if (target.selectionStart == null) return details;
    // 输入框内部排版交给 Chromium 定位光标，再按词界设置选区，避免后台双击不稳定。
    return { ...details, input: true };
  }
  const caret = document.caretPositionFromPoint?.(x, y, { shadowRoots: roots });
  const fallback = !caret && document.caretRangeFromPoint?.(x, y);
  const node = caret?.offsetNode ?? fallback?.startContainer;
  const offset = caret?.offset ?? fallback?.startOffset;
  if (!node || node.nodeType !== Node.TEXT_NODE) return details;
  const hit = document.createRange();
  let index = Math.min(offset, Math.max(0, node.length - 1));
  hit.setStart(node, index);
  hit.setEnd(node, Math.min(node.length, index + 1));
  if (offset > 0 && ![...hit.getClientRects()].some(rect => x >= rect.left && x <= rect.right)) {
    index = offset - 1;
    hit.setStart(node, index);
    hit.setEnd(node, offset);
  }
  // caretFromPoint 会吸附到附近文字；空白区域长按不能误选另一行。
  if (![...hit.getClientRects()].some(rect => x >= rect.left - 3 && x <= rect.right + 3 && y >= rect.top && y <= rect.bottom)) return details;
  let locale = target.closest("[lang]")?.lang || document.documentElement.lang || undefined;
  try { if (locale) Intl.getCanonicalLocales(locale); } catch { locale = undefined; }
  let segment;
  for (const part of new Intl.Segmenter(locale, { granularity: "word" }).segment(node.data)) {
    if (index >= part.index && index < part.index + part.segment.length) { segment = part; break; }
  }
  if (!segment || !segment.segment.trim()) return details;
  hit.setStart(node, segment.index);
  hit.setEnd(node, segment.index + segment.segment.length);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(hit);
  return { ...details, selection: String(selection).slice(0, 100000) };
}`;

export async function dispatchSelectWord(call, page, action) {
  const tree = await call(page, "Page.getFrameTree");
  const world = await call(page, "Page.createIsolatedWorld", {
    frameId: tree.frameTree.frame.id, worldName: "codeg-select-word",
  });
  const response = await call(page, "Runtime.evaluate", {
    contextId: world.executionContextId,
    expression: `(${selectWordSource})(${JSON.stringify({ x: action.x, y: action.y })})`,
    returnByValue: true, awaitPromise: true,
  });
  if (response.exceptionDetails) throw new Error("当前页面暂不支持长按选词。");
  const details = response.result?.value;
  if (!details) throw new Error("未能读取当前页面选区，请重试。");
  if (details.unsupported) throw new Error("此内嵌页面暂不支持长按选词，请在独立标签页打开后重试。");
  if (!details.input) return details;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await call(page, "Input.dispatchMouseEvent", {
      type, x: action.x, y: action.y, button: "left",
      buttons: type === "mousePressed" ? 1 : 0, clickCount: 1,
    });
  }
  const selected = await call(page, "Runtime.evaluate", {
    contextId: world.executionContextId,
    expression: `(() => {
      let target = document.activeElement;
      while (target?.shadowRoot?.activeElement) target = target.shadowRoot.activeElement;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) || (target instanceof HTMLInputElement && !["text", "search", "url", "tel", "email"].includes(target.type)) || target.selectionStart == null) return "";
      let locale = target.closest("[lang]")?.lang || document.documentElement.lang || undefined;
      try { if (locale) Intl.getCanonicalLocales(locale); } catch { locale = undefined; }
      const offset = Math.min(target.selectionStart, Math.max(0, target.value.length - 1));
      for (const part of new Intl.Segmenter(locale, { granularity: "word" }).segment(target.value)) {
        if (offset >= part.index && offset < part.index + part.segment.length) {
          if (!part.segment.trim()) return "";
          target.setSelectionRange(part.index, part.index + part.segment.length);
          break;
        }
      }
      return target.value.slice(target.selectionStart, target.selectionEnd).slice(0, 100000);
    })()`, returnByValue: true,
  });
  return { handled: false, linkUrl: details.linkUrl, editable: details.editable, selection: selected.result?.value ?? "" };
}

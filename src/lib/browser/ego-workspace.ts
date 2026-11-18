import { egoClientId, egoRequest, type EgoSession } from "./ego-api"
import { useSyncExternalStore } from "react"

const views = new Map<
  string,
  {
    sessionId: number
    tabId?: string | null
    connected: boolean
  }
>()
const approved = new Set<string>()
const closing = new Set<string>()
const suspended = new Set<string>()
const pages = new Map<
  string,
  { title: string; url: string; requestedUrl: string }
>()
const listeners = new Set<() => void>()
const closedListeners = new Set<(id: string) => void>()
const versions = new Map<number, { epoch: number; revision: number }>()

export function registerEgoView(
  id: string,
  sessionId: number,
  pending: Promise<unknown>
) {
  approved.delete(id)
  const view = { ...views.get(id), sessionId, connected: false }
  views.set(id, view)
  void pending.catch(() => {
    if (views.get(id) === view) view.connected = false
  })
}

export function markEgoViewDisconnected(id: string) {
  const view = views.get(id)
  if (view) view.connected = false
}

export function setEgoWorkspaceSuspended(id: string, value: boolean) {
  if (suspended.has(id) === value) return
  if (value) suspended.add(id)
  else suspended.delete(id)
  for (const listener of listeners) listener()
}

export function useEgoWorkspaceSuspended(id: string) {
  return useSyncExternalStore(
    subscribeEgoWorkspacePages,
    () => suspended.has(id),
    () => false
  )
}

export function publishEgoSession(session: EgoSession) {
  const previous = versions.get(session.sessionId)
  if (
    previous &&
    (session.control.epoch < previous.epoch ||
      (session.control.epoch === previous.epoch &&
        session.revision < previous.revision))
  )
    return
  versions.set(session.sessionId, {
    epoch: session.control.epoch,
    revision: session.revision,
  })
  let changed = false
  for (const [id, view] of views) {
    if (view.sessionId !== session.sessionId) continue
    view.connected = session.connected
    const tabId = session.views?.[id] ?? view.tabId
    const page = session.tabs.find((tab) => tab.id === tabId)
    if (
      view.tabId &&
      !page &&
      !session.tabs.some((tab) => tab.id === view.tabId)
    ) {
      view.tabId = null
      pages.delete(id)
      changed = true
      for (const listener of closedListeners) listener(id)
      continue
    }
    view.tabId = tabId
    if (
      page &&
      (pages.get(id)?.title !== page.title || pages.get(id)?.url !== page.url)
    ) {
      pages.set(id, {
        title: page.title,
        url: page.url,
        requestedUrl: page.url,
      })
      changed = true
    }
  }
  if (changed) for (const listener of listeners) listener()
}

export function getEgoWorkspacePage(id: string) {
  return pages.get(id) ?? null
}
export function subscribeEgoWorkspacePages(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function subscribeEgoClosedViews(listener: (id: string) => void) {
  closedListeners.add(listener)
  return () => {
    closedListeners.delete(listener)
  }
}
export function useEgoWorkspacePage(id: string) {
  return useSyncExternalStore(
    subscribeEgoWorkspacePages,
    () => getEgoWorkspacePage(id),
    () => null
  )
}

export function isEgoWorkspaceTab(id: string) {
  return views.has(id)
}

export function guardEgoWorkspaceClose(
  ids: string[],
  retry: () => void,
  failed: (error: unknown) => void
): boolean {
  const targets = ids.filter((id) => {
    const view = views.get(id)
    if (!view || approved.has(id)) return false
    // 未确认真实页面或已断线时只关闭本地入口，不能为了关闭再等待或启动连接。
    if (!view.connected || !view.tabId) {
      approved.add(id)
      return false
    }
    return true
  })
  if (!targets.length) return false
  if (targets.some((id) => closing.has(id))) return true
  for (const id of targets) closing.add(id)
  void (async () => {
    try {
      for (const id of targets) {
        const view = views.get(id)!
        let session: EgoSession
        try {
          session = await egoRequest<EgoSession>({
            method: "session",
            sessionId: view.sessionId,
          })
        } catch {
          // 断线后无法确认远端页面，只移除本地入口，不重试关闭或重放其他操作。
          view.connected = false
          approved.add(id)
          continue
        }
        // 后端关闭成功才移除工作区标签；只读、离线或确认阻塞时保留原入口。
        await egoRequest({
          method: "closeView",
          sessionId: view.sessionId,
          viewId: id,
          clientId: egoClientId(),
          epoch: session.control.epoch,
        })
        approved.add(id)
      }
      retry()
    } catch (error) {
      failed(error)
    } finally {
      for (const id of targets) closing.delete(id)
    }
  })()
  return true
}

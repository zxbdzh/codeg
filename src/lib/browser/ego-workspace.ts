import { egoClientId, egoRequest, type EgoSession } from "./ego-api"
import { useSyncExternalStore } from "react"

const views = new Map<
  string,
  { sessionId: number; pending: Promise<unknown>; tabId?: string | null }
>()
const approved = new Set<string>()
const closing = new Set<string>()
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
  views.set(id, { ...views.get(id), sessionId, pending })
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
  const targets = ids.filter((id) => views.has(id) && !approved.has(id))
  if (!targets.length) return false
  if (targets.some((id) => closing.has(id))) return true
  for (const id of targets) closing.add(id)
  void (async () => {
    try {
      for (const id of targets) {
        const view = views.get(id)!
        await view.pending
        const session = await egoRequest<EgoSession>({
          method: "session",
          sessionId: view.sessionId,
        })
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

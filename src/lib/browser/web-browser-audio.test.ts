import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { WebBrowserAudio } from "./web-browser-audio"

vi.mock("node:fs/promises", () => {
  const operations = { mkdir: vi.fn(), writeFile: vi.fn() }
  return { ...operations, default: operations }
})
vi.mock("../../../scripts/web-browser-assets.mjs", () => ({
  audioExtensionFiles: {},
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("Web tab audio playback", () => {
  it("reports buffer failures and releases the media resource", () => {
    const events = new Map<string, () => void>()
    const failure = new Error("quota exceeded")
    const onError = vi.fn()
    const element = {
      pause: vi.fn(),
      load: vi.fn(),
      play: vi.fn(() => Promise.resolve()),
      removeAttribute: vi.fn(),
      currentTime: 0,
    } as unknown as HTMLAudioElement
    const buffer = {
      updating: false,
      buffered: { length: 0 },
      addEventListener: (name: string, callback: () => void) =>
        events.set(name, callback),
      appendBuffer: () => {
        throw failure
      },
    }
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:test",
      revokeObjectURL: vi.fn(),
    })
    vi.stubGlobal(
      "MediaSource",
      class {
        static isTypeSupported = () => true
        addEventListener = (name: string, callback: () => void) =>
          events.set(name, callback)
        addSourceBuffer = () => buffer
      }
    )
    const player = new WebBrowserAudio(element, onError)
    player.start("audio/webm;codecs=opus")
    events.get("sourceopen")?.()
    player.append(btoa("bytes"))
    expect(onError).toHaveBeenCalledWith(failure)
    expect(element.load).toHaveBeenCalledTimes(3)
    events.get("error")?.()
    expect(onError).toHaveBeenCalledOnce()
  })

  it("buffers Opus chunks until the media source opens and releases audio on stop", () => {
    let sourceOpen = () => {}
    const appendBuffer = vi.fn()
    const buffer = {
      updating: false,
      appendBuffer,
      addEventListener: vi.fn(),
      buffered: { length: 0 },
    }
    vi.stubGlobal(
      "MediaSource",
      class {
        static isTypeSupported = () => true
        addEventListener = (_event: string, callback: () => void) => {
          sourceOpen = callback
        }
        addSourceBuffer = () => buffer
      }
    )
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = vi.fn(() => "blob:tab-audio")
    URL.revokeObjectURL = vi.fn()
    const element = {
      pause: vi.fn(),
      load: vi.fn(),
      play: vi.fn(() => Promise.resolve()),
      removeAttribute: vi.fn(),
      src: "",
      currentTime: 0,
    } as unknown as HTMLAudioElement
    try {
      const player = new WebBrowserAudio(element)
      player.start("audio/webm;codecs=opus")
      player.append(btoa("opus bytes"))
      expect(appendBuffer).not.toHaveBeenCalled()
      sourceOpen()
      expect(appendBuffer).toHaveBeenCalledOnce()
      expect(element.play).toHaveBeenCalledOnce()
      player.stop()
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:tab-audio")
      expect(element.removeAttribute).toHaveBeenCalledWith("src")
    } finally {
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
    }
  })
})

function recordingHarness(failRecorder = false) {
  let receive: (...args: unknown[]) => unknown = () => {}
  let resolveStream: () => void = () => {}
  let click: (tab: { id: number }) => Promise<void> = async () => {}
  const trackStop = vi.fn()
  const recorderStart = vi.fn()
  const getUserMedia = vi.fn(
    () =>
      new Promise((resolve) => {
        resolveStream = () =>
          resolve({ getTracks: () => [{ stop: trackStop }] })
      })
  )
  const context = {
    chrome: {
      runtime: {
        onMessage: {
          addListener: (callback: typeof receive) => {
            receive = callback
          },
        },
        sendMessage: (message: unknown) =>
          new Promise<unknown>((resolve) => {
            if (receive(message, {}, resolve) !== true) resolve(undefined)
          }),
      },
      action: {
        onClicked: {
          addListener: (callback: typeof click) => {
            click = callback
          },
        },
      },
      offscreen: { hasDocument: async () => true },
      tabCapture: { getMediaStreamId: async () => "stream" },
    },
    navigator: { mediaDevices: { getUserMedia } },
    MediaRecorder: class {
      onstop?: () => void
      constructor() {
        if (failRecorder) throw new Error("unsupported codec")
      }
      start = recorderStart
      stop = () => this.onstop?.()
    },
    console: { error: vi.fn() },
    Uint8Array,
    btoa,
    __codegStopAudio: vi.fn<(tabId: number) => void>(),
    __codegAudioLast: undefined as
      | undefined
      | { tabId: number; pending?: boolean; error?: string },
  }
  runInNewContext(
    readFileSync("scripts/web-browser-audio/offscreen.js", "utf8"),
    context
  )
  runInNewContext(
    readFileSync("scripts/web-browser-audio/worker.js", "utf8"),
    context
  )
  return {
    context,
    getUserMedia,
    trackStop,
    recorderStart,
    resolveStream: () => resolveStream(),
    click: () => click({ id: 7 }),
  }
}

describe("Web tab audio capture lifecycle", () => {
  it("waits for the recorder to start before acknowledging capture", async () => {
    const test = recordingHarness()
    const starting = test.click()
    await vi.waitFor(() => expect(test.getUserMedia).toHaveBeenCalled())
    expect(test.context.__codegAudioLast?.pending).toBe(true)
    test.resolveStream()
    await starting
    expect(test.recorderStart).toHaveBeenCalledWith(160)
    expect(test.context.__codegAudioLast).toEqual({
      tabId: 7,
      pending: false,
    })
  })

  it("cancels a capture stopped while getUserMedia is pending", async () => {
    const test = recordingHarness()
    const starting = test.click()
    await vi.waitFor(() => expect(test.getUserMedia).toHaveBeenCalled())
    test.context.__codegStopAudio(7)
    test.resolveStream()
    await starting
    expect(test.trackStop).toHaveBeenCalledOnce()
    expect(test.recorderStart).not.toHaveBeenCalled()
    expect(test.context.__codegAudioLast?.error).toBeTruthy()
  })

  it("releases acquired tracks and reports recorder construction failure", async () => {
    const test = recordingHarness(true)
    const starting = test.click()
    await vi.waitFor(() => expect(test.getUserMedia).toHaveBeenCalled())
    test.resolveStream()
    await starting
    expect(test.trackStop).toHaveBeenCalledOnce()
    expect(test.context.__codegAudioLast?.error).toBe("unsupported codec")
  })
})

function audioConnection(
  sleeping = false,
  loading = Promise.resolve(),
  droppedWake = false
) {
  let triggered = false
  let captureStarted = false
  let awake = !sleeping
  const call = vi.fn(
    async (method: string, params?: Record<string, unknown>) => {
      if (method === "Extensions.loadUnpacked") {
        await loading
        return { id: "test" }
      }
      if (method === "Extensions.triggerAction") {
        captureStarted = awake || triggered || !droppedWake
        triggered = true
        awake = true
      }
      if (method === "Target.getTargets")
        return {
          targetInfos: [
            {
              targetId: "tab",
              url: "https://example.com/",
              embedderData: { tabActive: true },
            },
            {
              targetId: "offscreen",
              url: "chrome-extension://test/offscreen.html",
            },
            ...(awake
              ? [
                  {
                    targetId: "worker",
                    url: "chrome-extension://test/worker.js",
                  },
                ]
              : []),
          ],
        }
      if (method === "Target.attachToTarget")
        return { sessionId: params?.targetId }
      if (method === "Runtime.evaluate")
        return {
          result: {
            value:
              params?.expression === "globalThis.__codegAudioReady === true"
                ? true
                : captureStarted
                  ? { tabId: 7, pending: false }
                  : undefined,
          },
        }
      return {}
    }
  )
  const pageCall = vi.fn(async (_session: unknown, method: string) => {
    if (method === "ServiceWorker.startWorker") awake = true
  })
  return { call, pageCall, listeners: new Set() }
}

describe("Web tab audio orchestration", () => {
  it("finishes a stop after an already pending start", async () => {
    const { createTabAudio } =
      await import("../../../scripts/web-browser-audio.mjs")
    let releaseLoad: () => void = () => {}
    const loading = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    const connection = audioConnection(false, loading)
    const send = vi.fn()
    const audio = createTabAudio({
      browser: async () => connection,
      pageCall: connection.pageCall,
      send,
      dataDir: "unused-audio-test",
    })
    const session = {
      targetId: "page",
      url: "https://example.com/",
      audio: false,
    }
    const starting = audio.start(session)
    await vi.waitFor(() =>
      expect(connection.call).toHaveBeenCalledWith(
        "Extensions.loadUnpacked",
        expect.anything()
      )
    )
    const stopping = audio.stop(session)
    releaseLoad()
    await Promise.all([starting, stopping])
    expect(session.audio).toBe(false)
    expect(send.mock.lastCall?.[1]).toEqual({ type: "audio-stop" })
  })

  it("wakes an inactive extension worker before waiting for readiness", async () => {
    vi.useFakeTimers()
    const { createTabAudio } =
      await import("../../../scripts/web-browser-audio.mjs")
    const connection = audioConnection(true)
    const audio = createTabAudio({
      browser: async () => connection,
      pageCall: connection.pageCall,
      send: vi.fn(),
      dataDir: "unused-audio-test",
    })
    const outcome = audio
      .start({ targetId: "page", url: "https://example.com/", audio: false })
      .then(
        () => null,
        (failure: unknown) => failure
      )
    await vi.runAllTimersAsync()
    expect(await outcome).toBeNull()
    expect(
      connection.call.mock.calls.filter(
        ([method]) => method === "Extensions.triggerAction"
      )
    ).toHaveLength(1)
  })

  it("starts the worker before posting an action that would be lost during wake", async () => {
    vi.useFakeTimers()
    const { createTabAudio } =
      await import("../../../scripts/web-browser-audio.mjs")
    const connection = audioConnection(true, Promise.resolve(), true)
    const audio = createTabAudio({
      browser: async () => connection,
      pageCall: connection.pageCall,
      send: vi.fn(),
      dataDir: "unused-audio-test",
    })
    const outcome = audio
      .start({ targetId: "page", url: "https://example.com/", audio: false })
      .then(
        () => null,
        (failure: unknown) => failure
      )
    await vi.runAllTimersAsync()
    expect(await outcome).toBeNull()
    expect(
      connection.call.mock.calls.filter(
        ([method]) => method === "Extensions.triggerAction"
      )
    ).toHaveLength(1)
    expect(connection.pageCall).toHaveBeenCalledWith(
      expect.anything(),
      "ServiceWorker.startWorker",
      { scopeURL: "chrome-extension://test/" }
    )
  })
})

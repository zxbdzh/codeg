import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { createContext, runInContext } from "node:vm"

const source = await readFile(
  new URL("./web-browser-video/offscreen.js", import.meta.url),
  "utf8"
)

async function openRtc() {
  const sent = []
  const failures = []
  const channels = new Map()
  const track = { contentHint: "", addEventListener() {} }
  let configured
  const context = createContext({
    chrome: { runtime: { onMessage: { addListener() {} } } },
    RTCPeerConnection: class {
      addTrack() {
        return {
          getParameters: () => ({ encodings: [{}] }),
          async setParameters(parameters) {
            configured = parameters
          },
        }
      }
      createDataChannel(label) {
        const channel = {}
        channels.set(label, channel)
        return channel
      }
      async createOffer() {
        return { type: "offer", sdp: "test-sdp" }
      }
      async setLocalDescription() {}
    },
  })
  runInContext(source, context)
  await context.startRtc(
    { stream: { getVideoTracks: () => [track] } },
    undefined,
    (message) => sent.push(message),
    (failure) => failures.push(failure)
  )
  return { track, configured, channels, sent, failures }
}

test("WebRTC preserves text detail and resolution before frame rate", async () => {
  const { track, configured } = await openRtc()
  assert.equal(track.contentHint, "text")
  assert.equal(configured.degradationPreference, "maintain-resolution")
  assert.equal(configured.encodings[0].scaleResolutionDownBy, 1)
  assert.equal(configured.encodings[0].maxFramerate, 60)
  assert.equal(configured.encodings[0].maxBitrate, 6_000_000)
})

test("text-quality capture keeps signaling and input ordering intact", async () => {
  const { channels, sent, failures } = await openRtc()
  assert.equal(sent[0].type, "rtc-offer")
  const control = channels.get("input")
  const hover = channels.get("hover")
  control.onmessage({
    data: JSON.stringify({
      sequence: 2,
      input: { type: "pointer", event: "mousePressed", buttons: 1 },
    }),
  })
  hover.onmessage({
    data: JSON.stringify({
      sequence: 1,
      input: { type: "pointer", event: "mouseMoved", buttons: 0 },
    }),
  })
  control.onmessage({
    data: JSON.stringify({
      sequence: 3,
      input: { type: "text", text: "清晰中文" },
    }),
  })
  assert.equal(sent.length, 3)
  assert.equal(sent[1].input.event, "mousePressed")
  assert.equal(sent[2].input.text, "清晰中文")
  assert.equal(failures.length, 0)
})

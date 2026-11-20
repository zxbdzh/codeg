import { readFile } from "node:fs/promises"

export const audioExtensionFiles = Object.fromEntries(
  await Promise.all(
    ["manifest.json", "worker.js", "offscreen.html", "offscreen.js"].map(
      async (name) => [
        name,
        await readFile(
          new URL(`./web-browser-audio/${name}`, import.meta.url),
          "utf8"
        ),
      ]
    )
  )
)
export const browserAgentSource = await readFile(
  new URL("../src-tauri/src/browser/js/agent.bundle.js", import.meta.url),
  "utf8"
)

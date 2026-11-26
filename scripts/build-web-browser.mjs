import { build } from "esbuild"
import path from "node:path"
import { readFile } from "node:fs/promises"

const outfile = process.argv[2]
if (!outfile)
  throw new Error(
    "Usage: node scripts/build-web-browser.mjs <absolute-output.mjs> [entry-point]"
  )
await build({
  entryPoints: [process.argv[3] || "scripts/web-browser-service.mjs"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: 'import { createRequire as __codegCreateRequire } from "node:module"; const require = __codegCreateRequire(import.meta.url); const __dirname = import.meta.dirname;',
  },
  plugins: [
    {
      name: "bundle-installed-websocket",
      setup(builder) {
        builder.onResolve({ filter: /^next\/dist\/compiled\/ws$/ }, () => ({
          path: path.resolve("node_modules/next/dist/compiled/ws/index.js"),
        }))
        builder.onLoad(
          { filter: /web-browser-(service|devtools)\.mjs$/ },
          async ({ path: filename }) => {
            const { readFile } = await import("node:fs/promises")
            return {
              contents: (await readFile(filename, "utf8"))
                .replace("const require = createRequire(import.meta.url)", "")
                .replace(
                  'const { WebSocketServer } = require("next/dist/compiled/ws")',
                  'import { WebSocketServer } from "next/dist/compiled/ws"'
                )
                .replace(
                  'const { WebSocket, WebSocketServer } = createRequire(import.meta.url)("next/dist/compiled/ws")',
                  'import { WebSocket, WebSocketServer } from "next/dist/compiled/ws"'
                ),
              loader: "js",
            }
          }
        )
        builder.onLoad({ filter: /web-browser-assets\.mjs$/ }, async () => {
          const files = Object.fromEntries(
            await Promise.all(
              [
                "manifest.json",
                "worker.js",
                "offscreen.html",
                "offscreen.js",
              ].map(async (name) => [
                name,
                await readFile(`scripts/web-browser-audio/${name}`, "utf8"),
              ])
            )
          )
          const source = await readFile(
            "src-tauri/src/browser/js/agent.bundle.js",
            "utf8"
          )
          const videoFiles = Object.fromEntries(
            await Promise.all(
              [
                "manifest.json",
                "worker.js",
                "offscreen.html",
                "offscreen.js",
              ].map(async (name) => [
                name,
                await readFile(`scripts/web-browser-video/${name}`, "utf8"),
              ])
            )
          )
          return {
            contents: `export const audioExtensionFiles=${JSON.stringify(files)}; export const browserAgentSource=${JSON.stringify(source)}; export const videoExtensionFiles=${JSON.stringify(videoFiles)};`,
            loader: "js",
          }
        })
      },
    },
  ],
})
console.log(`Browser service built: ${outfile}`)

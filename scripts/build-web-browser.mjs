import { build } from "esbuild"
import path from "node:path"

const outfile = process.argv[2]
if (!outfile)
  throw new Error(
    "Usage: node scripts/build-web-browser.mjs <absolute-output.mjs>"
  )
await build({
  entryPoints: ["scripts/web-browser-service.mjs"],
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
          { filter: /web-browser-service\.mjs$/ },
          async ({ path: filename }) => {
            const { readFile } = await import("node:fs/promises")
            return {
              contents: (await readFile(filename, "utf8"))
                .replace("const require = createRequire(import.meta.url)", "")
                .replace(
                  'const { WebSocketServer } = require("next/dist/compiled/ws")',
                  'import { WebSocketServer } from "next/dist/compiled/ws"'
                ),
              loader: "js",
            }
          }
        )
      },
    },
  ],
})
console.log(`Browser service built: ${outfile}`)

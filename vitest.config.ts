import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import path from "node:path"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The package ships an ESM file but its declared CJS main is absent.
      // Vite needs the concrete module when a real TerminalView is imported.
      "@xterm/addon-ligatures": path.resolve(
        __dirname,
        "./node_modules/@xterm/addon-ligatures/lib/addon-ligatures.mjs"
      ),
      "@": path.resolve(__dirname, "./src"),
      // The same alias esbuild resolves for the bundle: Playwright's sources
      // import each other through it, and honouring it here is what lets them
      // stay byte-identical to upstream.
      "@isomorphic": path.resolve(
        __dirname,
        "./browser-agent/vendor/playwright/isomorphic"
      ),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    // Node 22+ 内置了 webstorage 全局。没给 --localstorage-file 时 `localStorage`
    // 的值是 undefined，但它仍挂在 globalThis 上作为自有属性，会遮蔽 jsdom 注入
    // 的实现（连 window.localStorage 一起变成 undefined），于是所有依赖
    // localStorage 的测试整片失败。关掉这个实验特性，让 jsdom 正常接管；
    // 老版本 Node 不认识该选项，因此按主版本号判断。
    // Vitest 4 起 poolOptions 合并回顶层，execArgv 直接写在 test 下。
    execArgv:
      Number(process.versions.node.split(".")[0]) >= 22
        ? ["--no-experimental-webstorage"]
        : undefined,
    // `browser-agent/` is the isolated-world bundle's source. It is outside
    // `src/` because it is built by esbuild, not Next, and its vendored half
    // is held to Playwright's compiler settings rather than ours.
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "browser-agent/**/*.{test,spec}.ts",
    ],
    exclude: ["node_modules", "out", ".next", "src-tauri"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "browser-agent/vendor/**",
        "node_modules/",
        ".next/**",
        "out/**",
        "src/test-setup.ts",
        "**/*.test.{ts,tsx}",
        "**/*.spec.{ts,tsx}",
        "**/*.config.*",
        "**/*.d.ts",
        "src-tauri/**",
      ],
    },
  },
})

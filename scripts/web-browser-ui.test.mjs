import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { build } from "esbuild"
const { CdpConnection, startBrowserService } = await import(process.env.CODEG_TEST_BROWSER_MODULE || new URL("./web-browser-service.mjs", import.meta.url).href)

test(
  "real Web UI plays audio, embeds DevTools and changes agent permissions",
  { timeout: 90000 },
  async () => {
    let viewerBundle = ""
    const deployedHtml = existsSync("out/workspace.html")
      ? await readFile("out/workspace.html", "utf8")
      : ""
    const stylesheets = [
      ...new Set(
        [...deployedHtml.matchAll(/href="([^"]+\.css)"/g)].map(
          (match) => match[1]
        )
      ),
    ]
    const css = (
      await Promise.all(
        stylesheets.map((stylesheet) =>
          readFile(path.join("out", stylesheet), "utf8")
        )
      )
    ).join("\n")
    const fixture = createServer((request, response) => {
      if (request.url === "/api/health") {
        response
          .writeHead(
            request.headers.authorization === "Bearer ui-test-only" ? 200 : 401
          )
          .end()
        return
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      if (request.url === "/viewer") {
        response.end(
          `<style>${css}</style><div id="root"></div><script>${viewerBundle}</script>`
        )
        return
      }
      response.end(
        '<title>Web UI tone</title><h1>Live Web component acceptance</h1><input placeholder="Shared input"><button onclick="window.tone=new AudioContext();let oscillator=tone.createOscillator();oscillator.frequency.value=550;oscillator.connect(tone.destination);oscillator.start()" style="position:absolute;left:400px;top:90px;width:120px;height:50px">Play tone</button>'
      )
    })
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve))
    const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`
    const reserved = createServer()
    await new Promise((resolve) => reserved.listen(0, "127.0.0.1", resolve))
    const servicePort = reserved.address().port
    await new Promise((resolve) => reserved.close(resolve))
    const serviceOrigin = `http://127.0.0.1:${servicePort}`
    const dataDir = await mkdtemp("F:/tmp/codeg-web-ui-test-")
    const service = await startBrowserService({
      port: servicePort,
      origin: fixtureOrigin,
      publicOrigin: serviceOrigin,
      authUrl: `${fixtureOrigin}/api/health`,
      dataDir,
    })
    let browser
    let viewer
    try {
      const compiled = await build({
        stdin: {
          contents: `import React,{useState} from "react";import{createRoot}from"react-dom/client";import{BrowserWebSurface}from"./src/components/browser/browser-web-surface";function Test(){const[url,setUrl]=useState(${JSON.stringify(fixtureOrigin + "/tone")});return <div style={{width:"1200px",height:"760px",display:"flex",flexDirection:"column"}}><BrowserWebSurface tab={{id:"browser:ui-acceptance",browser:{initialUrl:url,profile:"default"}}} url={url} onNavigate={setUrl} reloadKey={0}/></div>}createRoot(document.getElementById("root")).render(<Test/>);`,
          resolveDir: process.cwd(),
          loader: "tsx",
        },
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: "chrome130",
        define: {
          "process.env.NODE_ENV": '"production"',
          "process.env.NEXT_PUBLIC_CODEG_BROWSER_URL":
            JSON.stringify(serviceOrigin),
        },
        plugins: [
          {
            name: "test-workspace-boundary",
            setup(builder) {
              builder.onResolve({ filter: /^@\// }, (args) => {
                if (
                  [
                    "@/contexts/workspace-context",
                    "@/lib/browser/browser-tab-store",
                    "@/lib/transport/web-auth",
                  ].includes(args.path)
                )
                  return { path: args.path, namespace: "test-boundary" }
                const location = path.resolve("src", args.path.slice(2))
                return {
                  path: [location, `${location}.ts`, `${location}.tsx`].find(
                    (filename) => existsSync(filename)
                  ),
                }
              })
              builder.onLoad(
                { filter: /.*/, namespace: "test-boundary" },
                (args) => ({
                  contents: args.path.endsWith("workspace-context")
                    ? "export const useOptionalWorkspaceActions=()=>null"
                    : args.path.endsWith("browser-tab-store")
                      ? "export const setBrowserTabState=(state)=>{window.__browserState=state}"
                      : 'export const getCodegToken=()=>"ui-test-only";export const codegAuthHeaders=()=>({Authorization:"Bearer ui-test-only"})',
                  loader: "js",
                })
              )
            },
          },
        ],
      })
      viewerBundle = compiled.outputFiles[0].text.replaceAll(
        "</script",
        "<\\/script"
      )
      const { createRequire } = await import("node:module")
      const { WebSocket } = createRequire(import.meta.url)(
        "next/dist/compiled/ws"
      )
      const bootstrap = new WebSocket(
        `${serviceOrigin.replace("http:", "ws:")}/socket`,
        [
          "codeg-browser",
          `codeg-token.${Buffer.from("ui-test-only").toString("base64url")}`,
        ],
        { origin: fixtureOrigin }
      )
      await new Promise((resolve, reject) => {
        bootstrap.once("open", resolve)
        bootstrap.once("error", reject)
      })
      bootstrap.send(
        JSON.stringify({
          type: "open",
          tabId: "browser:bootstrap",
          url: fixtureOrigin + "/tone",
        })
      )
      const activeFile = path.join(dataDir, "profile/DevToolsActivePort")
      let active
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          active = (await readFile(activeFile, "utf8")).trim().split(/\r?\n/)
          break
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.ok(active)
      browser = new CdpConnection(`ws://127.0.0.1:${active[0]}${active[1]}`)
      await browser.ready
      const { targetId } = await browser.call("Target.createTarget", {
        url: `${fixtureOrigin}/viewer`,
        background: true,
      })
      const { sessionId } = await browser.call("Target.attachToTarget", {
        targetId,
        flatten: true,
      })
      viewer = sessionId
      await browser.call(
        "Emulation.setDeviceMetricsOverride",
        { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
        viewer
      )
      const evaluate = async (expression, contextId) => {
        const result = await browser.call(
          "Runtime.evaluate",
          {
            expression,
            returnByValue: true,
            userGesture: true,
            ...(contextId ? { contextId } : {}),
          },
          viewer
        )
        if (result.exceptionDetails)
          throw new Error(
            result.exceptionDetails.exception?.description ||
              result.exceptionDetails.text
          )
        return result.result.value
      }
      const until = async (expression, contextId) => {
        const deadline = Date.now() + 20000
        while (Date.now() < deadline) {
          const result = await evaluate(`Boolean(${expression})`, contextId)
          if (result) return result
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        throw new Error(
          `UI acceptance timed out: ${expression}; body=${await evaluate("document.body.innerText")}; audio=${JSON.stringify(await evaluate("(()=>{let a=document.querySelector('audio');return{src:a.src,network:a.networkState,ready:a.readyState,paused:a.paused,time:a.currentTime,error:a.error?.message,mse:window.__mse?.readyState,buffers:window.__mse?.sourceBuffers?.length,events:window.__mseEvents}})()"))}`
        )
      }
      await until(
        'window.__browserState?.title==="Web UI tone" && document.querySelector("canvas")?.width>500'
      )
      await evaluate(
        'window.__mseEvents=[];window.__NativeMediaSource=MediaSource;window.MediaSource=class extends window.__NativeMediaSource{constructor(){super();window.__mse=this;for(let event of ["sourceopen","sourceended","sourceclose"])this.addEventListener(event,()=>window.__mseEvents.push(event))}}'
      )
      await evaluate(
        'document.querySelector(\'select[aria-label="Agent 访问权限"]\').value="control";document.querySelector(\'select[aria-label="Agent 访问权限"]\').dispatchEvent(new Event("change",{bubbles:true}))'
      )
      await until('window.__browserState?.agentGrant?.level==="control"')
      const mcp = await fetch(serviceOrigin + "/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer ui-test-only",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "browser_snapshot",
            arguments: { tabId: "browser:ui-acceptance" },
          },
        }),
      })
      const tree = JSON.parse((await mcp.json()).result.content[0].text)
      assert.match(tree.tree, /Shared input/)
      const targets = (
        await browser.call("Target.getTargets")
      ).targetInfos.filter(
        (item) => item.url === fixtureOrigin + "/tone" && item.type === "page"
      )
      const actual = targets.find((item) => item.targetId !== targetId)
      const actualSession = (
        await browser.call("Target.attachToTarget", {
          targetId: actual.targetId,
          flatten: true,
        })
      ).sessionId
      await browser.call(
        "Runtime.evaluate",
        {
          expression: "document.querySelector('button').click()",
          userGesture: true,
        },
        actualSession
      )
      // 两个目标同网址时，按当前组件的真实表单标记确认音频所在页。
      const other = targets.find((item) => item.targetId !== actual.targetId)
      if (other) {
        const link = (
          await browser.call("Target.attachToTarget", {
            targetId: other.targetId,
            flatten: true,
          })
        ).sessionId
        await browser.call(
          "Runtime.evaluate",
          {
            expression: "document.querySelector('button').click()",
            userGesture: true,
          },
          link
        )
      }
      await evaluate(
        "document.querySelector('button[aria-label=\"播放网站声音\"]').click()"
      )
      await until('!document.querySelector("audio").hidden')
      await browser.call("Target.activateTarget", { targetId })
      await until(
        'document.querySelector("audio").currentTime>0.25 && !document.querySelector("audio").paused'
      )
      await evaluate(
        "document.querySelector('button[aria-label=\"开发者工具\"]').click()"
      )
      await until("document.querySelector('iframe[title=\"网站开发者工具\"]')")
      await browser.call("Page.enable", {}, viewer)
      let inspectorFrame
      for (let attempt = 0; attempt < 100; attempt++) {
        inspectorFrame = (
          await browser.call("Page.getFrameTree", {}, viewer)
        ).frameTree.childFrames?.find((item) =>
          item.frame.url.includes("/devtools/inspector.html")
        )
        if (inspectorFrame) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.ok(inspectorFrame, "Inspector iframe was not loaded")
      const inspectorWorld = await browser.call(
        "Page.createIsolatedWorld",
        { frameId: inspectorFrame.frame.id, worldName: "ui-devtools-check" },
        viewer
      )
      await until(
        'document.body && (document.querySelector(".root-view") || document.querySelector("devtools-root") || document.querySelector("devtools-app"))',
        inspectorWorld.executionContextId
      )
    await evaluate('(()=>{const visit=root=>{for(const node of root.querySelectorAll("*")){if(node.getAttribute("aria-label")==="更多工具"||node.getAttribute("title")==="更多工具"){node.click();return true}if(node.shadowRoot&&visit(node.shadowRoot))return true}return false};return visit(document)})()',inspectorWorld.executionContextId)
    const inspectorItems=await evaluate('(()=>{const labels=[];const visit=root=>{for(const node of root.querySelectorAll("*")){if(["menuitem","option","tab"].includes(node.getAttribute("role")))labels.push({id:node.id,label:node.getAttribute("aria-label")||node.textContent?.slice(0,60)});if(node.shadowRoot)visit(node.shadowRoot)}};visit(document);return labels.slice(0,50)})()',inspectorWorld.executionContextId)
    console.log("DEVTOOLS_MENU",JSON.stringify(inspectorItems))
      await mkdir("F:/tmp/ego/shots", { recursive: true })
      const screenshot = await browser.call(
        "Page.captureScreenshot",
        { format: "png" },
        viewer
      )
      await writeFile(
        "F:/tmp/ego/shots/codeg-web-audio-devtools-agent-20261120.png",
        Buffer.from(screenshot.data, "base64")
      )
      await evaluate(
        "document.querySelector('button[aria-label=\"关闭声音\"]').click()"
      )
      await until('document.querySelector("audio").hidden')
      bootstrap.close()
      console.log(
        "REAL_UI_PASS: live page pixels, audio decoded and playing, embedded DevTools loaded, user sharing reached agent snapshot"
      )
    } finally {
      await service.stop()
      browser?.socket.close()
      await new Promise((resolve) => fixture.close(resolve))
    }
  }
)

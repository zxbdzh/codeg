import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import * as React from "react"
import { render, screen } from "@testing-library/react"
import ts from "typescript"
import { describe, expect, it } from "vitest"

import {
  OverlayHostHiddenProvider,
  useOverlayHostHidden,
} from "@/components/ui/overlay-host-hidden"
import { cn } from "@/lib/utils"

const source = ts.createSourceFile(
  "layout.tsx",
  readFileSync(resolve(process.cwd(), "src/app/workspace/layout.tsx"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)
const workspace = source.statements.find(
  (statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) &&
    statement.name?.text === "WorkspaceContent"
)!
const declarations = workspace
  .body!.statements.filter(ts.isVariableStatement)
  .flatMap((statement) => [...statement.declarationList.declarations])
  .filter((declaration) =>
    [
      "conversationFillsArea",
      "conversationFocused",
      "fileFocused",
      "conversationHidden",
      "filesHidden",
    ].includes(declaration.name.getText(source))
  )
  .map((declaration) => `const ${declaration.getText(source)};`)
  .join("\n")

const columns: string[] = []
function visit(node: ts.Node) {
  if (
    ts.isJsxElement(node) &&
    node.openingElement.tagName.getText(source) === "OverlayHostHiddenProvider"
  ) {
    const section = node.children.find(
      (child): child is ts.JsxElement =>
        ts.isJsxElement(child) &&
        child.openingElement.tagName.getText(source) === "section"
    )
    if (section) {
      const name = columns.length === 0 ? "conversation" : "files"
      columns.push(
        `${node.openingElement.getText(source)}
          ${section.openingElement.getText(source)}
            <HiddenProbe name="${name}" />
          </section>
        </OverlayHostHiddenProvider>`
      )
    }
  }
  ts.forEachChild(node, visit)
}
visit(workspace)

function HiddenProbe({ name }: { name: string }) {
  return (
    <span data-testid={`${name}-overlay`}>
      {String(useOverlayHostHidden())}
    </span>
  )
}

type ViewState = {
  mode: "conversation" | "fusion"
  filesMaximized: boolean
  conversationMaximized: boolean
  focusedTabPane: "conversation" | "files" | null
}

// 执行布局中真实的 section 属性，避免测试里的另一套隐藏条件掩盖回归。
const Columns = new Function(
  "React",
  "cn",
  "OverlayHostHiddenProvider",
  "HiddenProbe",
  ts.transpileModule(
    `function Columns({ mode, filesMaximized, conversationMaximized, focusedTabPane }) {
      ${declarations}
      return <>${columns.join("\n")}</>
    }`,
    { compilerOptions: { jsx: ts.JsxEmit.React } }
  ).outputText + "\nreturn Columns"
)(React, cn, OverlayHostHiddenProvider, HiddenProbe) as (
  state: ViewState
) => React.ReactNode

describe("workspace column visibility", () => {
  it.each([
    ["conversation mode", { mode: "conversation" }, false, true],
    ["fusion mode", {}, false, false],
    ["maximized files", { filesMaximized: true }, true, false],
    ["maximized conversation", { conversationMaximized: true }, false, true],
    ["focused file", { focusedTabPane: "files" }, true, false],
    ["focused conversation", { focusedTabPane: "conversation" }, false, true],
  ] as const)(
    "%s hides the covered column and its overlays together",
    (_name, overrides, conversationHidden, filesHidden) => {
      expect(columns).toHaveLength(2)
      render(
        <Columns
          mode="fusion"
          filesMaximized={false}
          conversationMaximized={false}
          focusedTabPane={null}
          {...overrides}
        />
      )

      for (const [name, hidden] of [
        ["conversation", conversationHidden],
        ["files", filesHidden],
      ] as const) {
        const probe = screen.getByTestId(`${name}-overlay`)
        const section = probe.closest("section")!
        expect(section.classList.contains("invisible")).toBe(hidden)
        expect(section.classList.contains("conversation-tab-hidden")).toBe(
          hidden
        )
        expect(section.hasAttribute("inert")).toBe(hidden)
        expect(section.getAttribute("aria-hidden") === "true").toBe(hidden)
        expect(probe.textContent).toBe(String(hidden))
      }
    }
  )
})

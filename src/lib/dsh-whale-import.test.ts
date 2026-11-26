import { describe, expect, it } from "vitest"

import { translateDshWidgetImport } from "./dsh-whale-import"

describe("translateDshWidgetImport", () => {
  it("leaves the Codeg widget size alone when only a bubble file is imported", () => {
    const translated = translateDshWidgetImport({
      bubble: {
        items: [
          {
            kind: "custom",
            modules: [{ type: "text", text: "only bubble", size: 8 }],
          },
        ],
      },
    })

    expect(translated.widgetSize).toBeNull()
    expect(translated.options.sequence).toHaveLength(1)
  })

  it("translates the active DSH size and bubble appearance without touching Codeg data", () => {
    const translated = translateDshWidgetImport(
      {
        size: { scale: 0.8 },
        bubble: {
          v: 1,
          tapAdvance: false,
          items: [
            {
              kind: "custom",
              modules: [
                {
                  type: "text",
                  text: "lk888 余额",
                  size: 8,
                  bold: true,
                },
                {
                  type: "balance",
                  modelId: "api_mwu2hg7c_29t3w",
                  size: 10,
                  tpl: "{balance}",
                  fontFamily: "MiSans",
                  rgb: "aurora",
                  bold: true,
                },
              ],
            },
            {
              kind: "choice",
              options: [
                {
                  w: 10,
                  item: {
                    kind: "custom",
                    modules: [
                      {
                        type: "random",
                        size: 8,
                        lines: [
                          { t: "好模型...↓", w: 10, bold: true, size: 22 },
                          {
                            t: "没吃饱喵",
                            w: 3,
                            bold: true,
                            size: 10,
                            rgb: "candy",
                          },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
            {
              kind: "custom",
              modules: [{ type: "image", imgId: "bimg_petpet", size: 6 }],
            },
          ],
        },
      },
      {
        assets: [
          {
            id: "existing",
            name: "existing.png",
            data: "data:image/png;base64,AA==",
          },
        ],
      }
    )

    expect(translated.widgetSize).toBe(35)
    expect(translated.options.assets?.[0]?.id).toBe("existing")
    expect(translated.options.advanceOnAvatar).toBe(false)
    expect(translated.options.sequence).toHaveLength(3)

    const balanceRows = translated.options.sequence?.[0]?.[0]?.rows
    expect(balanceRows).toHaveLength(2)
    expect(balanceRows?.[0]?.[0]).toMatchObject({
      type: "text",
      value: "lk888 余额",
      size: 8,
      bold: true,
    })
    expect(balanceRows?.[1]?.[0]).toMatchObject({
      type: "balance",
      value: "{balance}",
      size: 10,
      font: "MiSans",
      bold: true,
    })

    const random = translated.options.sequence?.[1]?.[0]?.rows?.[0]?.[0]
    expect(translated.options.sequence?.[1]?.[0]?.weight).toBe(10)
    expect(random).toMatchObject({ type: "randomText", size: 8 })
    expect(random?.value).toContain("10|好模型...↓")
    expect(random?.value).toContain("3|没吃饱喵")

    expect(translated.options.sequence?.[2]?.[0]?.rows?.[0]?.[0]).toMatchObject(
      {
        type: "image",
        value: "bimg_petpet",
        size: 6,
      }
    )
    expect(translated.warnings.join(" ")).toContain("图片素材")
    expect(translated.warnings.join(" ")).toContain("行级")
  })
})

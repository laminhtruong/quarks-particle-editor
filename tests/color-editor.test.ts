import { describe, expect, it } from 'vitest'
import { Gradient, Vector3, Vector4 } from 'three.quarks'
import {
  colorEditorMarkup,
  gradientCss,
  hsvToRgb,
  parseColorHex,
  rgbToHsv,
  sampleGradient,
} from '../src/color-editor'
import type { NativeRecord } from '../src/native-properties'

describe('Unity-style color editor', () => {
  it.each([
    [0, { r: 1, g: 0, b: 0 }],
    [1 / 6, { r: 1, g: 1, b: 0 }],
    [1 / 3, { r: 0, g: 1, b: 0 }],
    [0.5, { r: 0, g: 1, b: 1 }],
    [2 / 3, { r: 0, g: 0, b: 1 }],
    [5 / 6, { r: 1, g: 0, b: 1 }],
  ] as const)('converts hue %s in both directions', (hue, color) => {
    expect(hsvToRgb(hue, 1, 1)).toEqual(color)
    expect(rgbToHsv(color)[0]).toBeCloseTo(hue)
  })

  it('round-trips dim and desaturated colors without quantizing them', () => {
    for (const r of [0, 0.04, 0.5, 1]) {
      for (const g of [0, 0.2, 0.8, 1]) {
        for (const b of [0, 0.3, 0.6, 1]) {
          const result = hsvToRgb(...rgbToHsv({ r, g, b }))
          expect(result.r).toBeCloseTo(r)
          expect(result.g).toBeCloseTo(g)
          expect(result.b).toBeCloseTo(b)
        }
      }
    }
    expect(rgbToHsv({ r: 0, g: 0, b: 0 })).toEqual([0, 0, 0])
    expect(rgbToHsv({ r: 1, g: 1, b: 1 })).toEqual([0, 0, 1])
  })

  it('accepts RGB/RGBA hex without silently accepting invalid input', () => {
    expect(parseColorHex(' #FF008080 ')).toEqual({ r: 1, g: 0, b: 128 / 255, a: 128 / 255 })
    expect(parseColorHex('aaff00')).toEqual({ r: 170 / 255, g: 1, b: 0 })
    for (const text of ['', 'FFF', '1234567', 'GG000000', '12345678junk', '<b>123456</b>']) {
      expect(parseColorHex(text)).toBeUndefined()
    }
  })

  it('samples independent color and alpha tracks like the installed Quarks runtime', () => {
    const gradient = new Gradient(
      [
        [new Vector3(1, 0, 0), 0.1],
        [new Vector3(0, 0.5, 1), 0.6],
        [new Vector3(1, 1, 0), 0.9],
      ],
      [
        [0.2, 0],
        [0.9, 0.35],
        [0, 1],
      ],
    )
    const json = gradient.toJSON() as NativeRecord
    for (const pos of [0, 0.1, 0.25, 0.35, 0.6, 0.75, 0.9, 1]) {
      const actual = sampleGradient(json, pos)
      const expected = gradient.genColor([], new Vector4(), pos)
      expect(actual.r).toBeCloseTo(expected.x)
      expect(actual.g).toBeCloseTo(expected.y)
      expect(actual.b).toBeCloseTo(expected.z)
      expect(actual.a).toBeCloseTo(expected.w)
    }
    expect(gradientCss(json)).toContain('35%')
    expect(gradientCss(json)).not.toMatch(/NaN|undefined/)
  })

  it('handles coincident stops without dividing by zero or changing saved order', () => {
    const json = new Gradient().toJSON() as NativeRecord
    const before = structuredClone(json)
    expect(sampleGradient(json, 0)).toEqual({ r: 1, g: 1, b: 1, a: 1 })
    expect(gradientCss(json)).not.toContain('NaN')
    expect(json).toEqual(before)
  })

  it('uses an accessible custom dialog instead of a browser color input', () => {
    expect(colorEditorMarkup('color')).toContain('aria-label="Color editor"')
    expect(colorEditorMarkup('gradient')).toContain('aria-label="Gradient editor"')
    expect(colorEditorMarkup('color')).not.toContain('type="color"')
  })
})

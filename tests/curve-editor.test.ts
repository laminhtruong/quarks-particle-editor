import { describe, expect, it } from 'vitest'
import { Bezier, PiecewiseBezier } from 'three.quarks'
import {
  applyCurvePreset,
  curveBounds,
  curveEditorMarkup,
  curvePath,
  curvePresets,
  curvePreview,
  curveTicks,
  insertCurveKey,
  moveCurveKey,
  removeCurveKey,
  setCurveTangent,
} from '../src/curve-editor'
import { validateNative } from '../src/native-properties'

const makeCurve = () => new PiecewiseBezier([[new Bezier(-2, 4, -3, 5), 0]]).toJSON()
const samples = (json: ReturnType<typeof makeCurve>) => {
  const curve = PiecewiseBezier.fromJSON(json)
  return Array.from({ length: 101 }, (_, i) => curve.genValue([], i / 100))
}

describe('visual cubic curve editor', () => {
  it('uses readable axis ticks across negative, large, and zoomed-in ranges', () => {
    expect(curveTicks(-0.12, 1.29)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1, 1.2])
    for (const [low, high] of [
      [-800, -120],
      [0.00004, 0.00016],
      [-1e8, 1e8],
    ]) {
      const ticks = curveTicks(low!, high!)
      expect(ticks.length).toBeGreaterThan(0)
      expect(ticks.length).toBeLessThanOrEqual(10)
      expect(ticks.every((n) => n >= low! && n <= high!)).toBe(true)
      expect(ticks.every((n, i) => i === 0 || n > ticks[i - 1]!)).toBe(true)
    }
  })
  it('adds keys at arbitrary times without changing the Quarks curve', () => {
    const value = makeCurve(),
      before = samples(value)
    for (const time of [0.31, 0.07, 0.86, 0.5])
      expect(insertCurveKey(value, time)).toBeGreaterThan(0)
    samples(value).forEach((n, i) => expect(n).toBeCloseTo(before[i]!, 10))
    validateNative(value)
    const previous = structuredClone(value)
    for (const time of [-1, 0, 0.31, 1, 2, NaN]) expect(insertCurveKey(value, time)).toBe(-1)
    expect(value).toEqual(previous)
  })

  it('removes internal keys while retaining endpoint slopes and protecting endpoints', () => {
    const value = makeCurve(),
      original = structuredClone(value)
    insertCurveKey(value, 0.3)
    expect(removeCurveKey(value, 0)).toBe(false)
    expect(removeCurveKey(value, 2)).toBe(false)
    expect(removeCurveKey(value, 1)).toBe(true)
    const actual = value.functions[0].function,
      expected = original.functions[0].function
    for (const part of ['p0', 'p1', 'p2', 'p3'])
      expect(actual[part]).toBeCloseTo(expected[part], 10)
  })

  it('moves keys with their tangent offsets, clamps times, and allows negative / large values', () => {
    const value = makeCurve()
    insertCurveKey(value, 0.5)
    const right = value.functions[1].function,
      left = value.functions[0].function
    const outgoing = right.p1 - right.p0,
      incoming = left.p2 - left.p3
    moveCurveKey(value, 1, -3, -12)
    expect(value.functions[1].start).toBeGreaterThan(0)
    expect(right.p0).toBe(-12)
    expect(left.p3).toBe(-12)
    expect(right.p1 - right.p0).toBeCloseTo(outgoing)
    expect(left.p2 - left.p3).toBeCloseTo(incoming)
    moveCurveKey(value, 1, 4, 20)
    expect(value.functions[1].start).toBeLessThan(1)
    moveCurveKey(value, 0, 0.8, -5)
    moveCurveKey(value, 2, 0.2, 8)
    expect(value.functions[0].start).toBe(0)
    expect(right.p3).toBe(8)
    validateNative(value)
    const previous = structuredClone(value)
    moveCurveKey(value, 1, NaN, 2)
    moveCurveKey(value, 1, 0.5, Infinity)
    expect(value).toEqual(previous)
  })

  it('sets flat, linear, and smooth tangents in normalized time across unequal segments', () => {
    const value = makeCurve()
    insertCurveKey(value, 0.2)
    const left = value.functions[0].function,
      right = value.functions[1].function
    setCurveTangent(value, 1, 'flat')
    expect(left.p2).toBe(left.p3)
    expect(right.p1).toBe(right.p0)
    setCurveTangent(value, 1, 'linear')
    expect(((left.p3 - left.p2) * 3) / 0.2).toBeCloseTo((left.p3 - left.p0) / 0.2)
    expect(((right.p1 - right.p0) * 3) / 0.8).toBeCloseTo((right.p3 - right.p0) / 0.8)
    setCurveTangent(value, 1, 'smooth')
    expect(((left.p3 - left.p2) * 3) / 0.2).toBeCloseTo(((right.p1 - right.p0) * 3) / 0.8)
    setCurveTangent(value, 0, 'smooth')
    setCurveTangent(value, 2, 'smooth')
    validateNative(value)
  })

  it('draws exact cubic segments, preserves discontinuities and does not mutate imported data', () => {
    const value = new PiecewiseBezier([
      [new Bezier(2, 3, -1, 4), 0.1],
      [new Bezier(-2, 1, 0, 3), 0.6],
    ]).toJSON()
    const before = structuredClone(value)
    const path = curvePath(
      value,
      (n) => n,
      (n) => n,
    )
    expect(path).toContain('M0.1,2 C')
    expect(path).toContain('M0.6,-2 C')
    expect(curvePreview(value)).not.toMatch(/NaN|undefined/)
    const [low, high] = curveBounds(value)
    expect(low).toBeLessThan(-2)
    expect(high).toBeGreaterThan(4)
    expect(value).toEqual(before)
  })

  it.each(curvePresets.map((preset, i) => [preset.name, i] as const))(
    'creates a valid %s preset',
    (_name, i) => {
      const value = makeCurve()
      applyCurvePreset(value, i)
      validateNative(value)
      expect(samples(value).every(Number.isFinite)).toBe(true)
      expect(value.functions).toHaveLength(1)
    },
  )

  it('provides labeled dialog controls, presets, and explicit Apply / Cancel', () => {
    const html = curveEditorMarkup()
    expect(html).toContain('aria-label="Particle System Curves"')
    expect(html).toContain('data-native-action="curve-editor-apply"')
    expect(html).toContain('data-native-action="curve-editor-cancel"')
    expect(html.match(/data-curve-preset=/g)).toHaveLength(curvePresets.length)
    expect(html).not.toMatch(/NaN|undefined/)
  })
})

import type { NativeRecord } from './native-properties.js'

type Segment = { start: number; function: { p0: number; p1: number; p2: number; p3: number } }
const segments = (value: NativeRecord): Segment[] => value.functions as Segment[]
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))
const number = (n: number) => String(Number(n.toPrecision(5)))
const W = 800,
  H = 400,
  L = 64,
  R = 776,
  T = 24,
  B = 360

export const curvePresets = [
  { name: 'Constant', points: [1, 1, 1, 1] },
  { name: 'Linear up', points: [0, 1 / 3, 2 / 3, 1] },
  { name: 'Linear down', points: [1, 2 / 3, 1 / 3, 0] },
  { name: 'Ease in', points: [0, 0, 0, 1] },
  { name: 'Ease out', points: [0, 1, 1, 1] },
  { name: 'Smooth up', points: [0, 0, 1, 1] },
  { name: 'Smooth down', points: [1, 1, 0, 0] },
  { name: 'Bell', points: [0, 4 / 3, 4 / 3, 0] },
] as const

export function applyCurvePreset(value: NativeRecord, index: number): void {
  const preset = curvePresets[index]
  if (!preset) return
  const [p0, p1, p2, p3] = preset.points
  value.functions = [{ start: 0, function: { p0, p1, p2, p3 } }]
}

export function curveBounds(value: NativeRecord): [number, number] {
  const values = segments(value).flatMap(({ function: p }) => [p.p0, p.p1, p.p2, p.p3])
  const low = Math.min(0, ...values),
    high = Math.max(1, ...values)
  const padding = (high - low) * 0.1
  return [low - padding, high + padding]
}

export function curveTicks(low: number, high: number): number[] {
  const rough = (high - low) / 8
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 5, 10].find((n) => n * magnitude >= rough)! * magnitude
  const first = Math.ceil(low / step) * step
  return Array.from({ length: Math.max(0, Math.floor((high - first) / step) + 1) }, (_, i) =>
    Number((first + i * step).toPrecision(12)),
  )
}

export function curvePath(
  value: NativeRecord,
  x: (n: number) => number,
  y: (n: number) => number,
): string {
  return segments(value)
    .map((segment, i, all) => {
      const a = segment.start,
        b = all[i + 1]?.start ?? 1,
        p = segment.function
      return `M${x(a)},${y(p.p0)} C${x(a + (b - a) / 3)},${y(p.p1)} ${x(b - (b - a) / 3)},${y(p.p2)} ${x(b)},${y(p.p3)}`
    })
    .join(' ')
}

export function curvePreview(value: NativeRecord): string {
  const [low, high] = curveBounds(value)
  return `<svg class="native-curve" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Bezier curve preview"><path d="${curvePath(
    value,
    (n) => n * 100,
    (n) => 95 - ((n - low) * 90) / (high - low),
  )}"/></svg>`
}

/** De Casteljau subdivision preserves the imported cubic exactly. */
export function insertCurveKey(value: NativeRecord, time: number): number {
  const all = segments(value)
  if (!Number.isFinite(time)) return -1
  const index = all.findIndex(
    (s, i) => time > s.start + 0.00001 && time < (all[i + 1]?.start ?? 1) - 0.00001,
  )
  if (index < 0) return -1
  const s = all[index]!,
    p = s.function
  const t = (time - s.start) / ((all[index + 1]?.start ?? 1) - s.start)
  const mix = (a: number, b: number) => a + (b - a) * t
  const a = mix(p.p0, p.p1),
    b = mix(p.p1, p.p2),
    c = mix(p.p2, p.p3)
  const d = mix(a, b),
    e = mix(b, c),
    middle = mix(d, e)
  const right = structuredClone(s)
  right.start = time
  right.function = { ...p, p0: middle, p1: e, p2: c }
  s.function = { ...p, p1: a, p2: d, p3: middle }
  all.splice(index + 1, 0, right)
  return index + 1
}

export function moveCurveKey(
  value: NativeRecord,
  index: number,
  time: number,
  height: number,
): void {
  const all = segments(value)
  if (!Number.isFinite(time) || !Number.isFinite(height) || index < 0 || index > all.length) return
  const right = all[index],
    left = all[index - 1]
  if (right) {
    if (left) {
      const end = all[index + 1]?.start ?? 1
      const gap = Math.min(0.0001, (end - left.start) / 4)
      right.start = clamp(time, left.start + gap, end - gap)
    }
    const delta = height - right.function.p0
    right.function.p0 = height
    right.function.p1 += delta
  }
  if (left) {
    const delta = height - left.function.p3
    left.function.p3 = height
    left.function.p2 += delta
  }
}

export function removeCurveKey(value: NativeRecord, index: number): boolean {
  const all = segments(value),
    left = all[index - 1],
    right = all[index]
  if (!left || !right) return false
  const end = all[index + 1]?.start ?? 1,
    span = end - left.start
  left.function.p1 =
    left.function.p0 + ((left.function.p1 - left.function.p0) * span) / (right.start - left.start)
  left.function.p2 =
    right.function.p3 + ((right.function.p2 - right.function.p3) * span) / (end - right.start)
  left.function.p3 = right.function.p3
  all.splice(index, 1)
  return true
}

export function setCurveTangent(
  value: NativeRecord,
  index: number,
  mode: 'flat' | 'linear' | 'smooth',
): void {
  const all = segments(value),
    left = all[index - 1],
    right = all[index]
  const before = left
    ? (left.function.p3 - left.function.p0) / ((right?.start ?? 1) - left.start)
    : 0
  const after = right
    ? (right.function.p3 - right.function.p0) / ((all[index + 1]?.start ?? 1) - right.start)
    : 0
  const slope = mode === 'flat' ? 0 : left && right ? (before + after) / 2 : left ? before : after
  if (left)
    left.function.p2 =
      left.function.p3 -
      ((mode === 'linear' ? before : slope) * ((right?.start ?? 1) - left.start)) / 3
  if (right)
    right.function.p1 =
      right.function.p0 +
      ((mode === 'linear' ? after : slope) * ((all[index + 1]?.start ?? 1) - right.start)) / 3
}

export function curveEditorMarkup(): string {
  return `<dialog class="color-editor-dialog curve-editor-dialog" aria-label="Particle System Curves"><header><strong>Particle System Curves</strong><button class="color-editor-close" type="button" aria-label="Close" data-native-action="curve-editor-cancel">&times;</button></header><div class="curve-editor-body"><div class="curve-editor-toolbar"><strong data-curve-title></strong><button class="btn small" type="button" data-curve-tool="fit">Fit</button></div><svg class="curve-editor-graph" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Curve graph. Double-click to add a key. Drag keys and tangent handles."></svg><div class="curve-editor-selection"><label>Time <input type="number" min="0" max="1" step="0.01" data-curve-field="time"></label><label>Value <input type="number" step="0.01" data-curve-field="value"></label><button class="btn small danger" type="button" data-curve-tool="remove">Delete key</button></div><div class="curve-editor-tools"><button class="btn small" type="button" data-curve-tool="add">+ Key</button><span>Tangents</span><button class="btn small" type="button" data-curve-tool="smooth">Smooth</button><button class="btn small" type="button" data-curve-tool="linear">Linear</button><button class="btn small" type="button" data-curve-tool="flat">Flat</button></div><div class="curve-editor-presets" aria-label="Curve presets">${curvePresets
    .map((preset, index) => {
      const curve = {
        functions: [
          { start: 0, function: Object.fromEntries(preset.points.map((n, i) => [`p${i}`, n])) },
        ],
      }
      return `<button type="button" title="${preset.name}" aria-label="${preset.name}" data-curve-preset="${index}"><svg viewBox="0 0 60 28" aria-hidden="true"><path d="${curvePath(
        curve,
        (n) => 3 + n * 54,
        (n) => 25 - n * 22,
      )}"/></svg></button>`
    })
    .join(
      '',
    )}</div><p class="hint">Double-click to add · Drag keys / tangents · Wheel to zoom vertically · Alt + drag to pan · Arrow keys to nudge (Shift: ×10)<br>Quarks tangent handles move vertically; time is normalized from 0 to 1.</p></div><footer><button class="btn" type="button" data-native-action="curve-editor-cancel">Cancel</button><button class="btn primary" type="button" data-native-action="curve-editor-apply">Apply</button></footer></dialog>`
}

export function bindCurveEditor(
  dialog: HTMLDialogElement,
  value: NativeRecord,
  title: string,
): void {
  const svg = dialog.querySelector<SVGSVGElement>('.curve-editor-graph')!
  const field = (name: string) =>
    dialog.querySelector<HTMLInputElement>(`[data-curve-field="${name}"]`)!
  dialog.querySelector('[data-curve-title]')!.textContent = title
  let selected = 0,
    [low, high] = curveBounds(value)
  const x = (n: number) => L + n * (R - L)
  const y = (n: number) => B - ((n - low) * (B - T)) / (high - low)
  const key = () => {
    const all = segments(value),
      s = all[selected]
    return { time: s?.start ?? 1, height: s ? s.function.p0 : all.at(-1)!.function.p3 }
  }
  const coords = (event: MouseEvent) => {
    const rect = svg.getBoundingClientRect()
    return {
      time: (((event.clientX - rect.left) * W) / rect.width - L) / (R - L),
      height: low + ((B - ((event.clientY - rect.top) * H) / rect.height) * (high - low)) / (B - T),
    }
  }

  function render(source?: HTMLInputElement): void {
    const all = segments(value),
      current = key()
    const grid =
      Array.from({ length: 11 }, (_, i) => {
        const t = i / 10
        return `<line x1="${x(t)}" y1="${T}" x2="${x(t)}" y2="${B}"/><text x="${x(t)}" y="385" text-anchor="middle">${number(t)}</text>`
      }).join('') +
      curveTicks(low, high)
        .map(
          (v) =>
            `<line x1="${L}" y1="${y(v)}" x2="${R}" y2="${y(v)}"/><text x="54" y="${y(v) + 4}" text-anchor="end">${number(v)}</text>`,
        )
        .join('')
    const handle = (
      i: number,
      part: 'p1' | 'p2',
      time: number,
      height: number,
      anchorTime: number,
      anchorHeight: number,
    ) =>
      `<line class="curve-tangent-line" x1="${x(anchorTime)}" y1="${y(anchorHeight)}" x2="${x(time)}" y2="${y(height)}"/><circle class="curve-tangent" cx="${x(time)}" cy="${y(height)}" r="6" tabindex="0" role="button" aria-label="${part === 'p1' ? 'Outgoing' : 'Incoming'} tangent; use up and down arrows" data-tangent-segment="${i}" data-tangent-part="${part}"/>`
    const right = all[selected],
      left = all[selected - 1]
    const tangents =
      (left
        ? handle(
            selected - 1,
            'p2',
            current.time - (current.time - left.start) / 3,
            left.function.p2,
            current.time,
            left.function.p3,
          )
        : '') +
      (right
        ? handle(
            selected,
            'p1',
            current.time + ((all[selected + 1]?.start ?? 1) - current.time) / 3,
            right.function.p1,
            current.time,
            right.function.p0,
          )
        : '')
    svg.innerHTML = `<defs><clipPath id="curve-plot"><rect x="${L - 8}" y="${T - 8}" width="${R - L + 16}" height="${B - T + 16}"/></clipPath></defs><g class="curve-grid">${grid}</g><g clip-path="url(#curve-plot)"><line class="curve-zero" x1="${L}" y1="${y(0)}" x2="${R}" y2="${y(0)}"/><path class="curve-editor-path" d="${curvePath(value, x, y)}"/>${tangents}${Array.from(
      { length: all.length + 1 },
      (_, i) => {
        const time = all[i]?.start ?? 1,
          height = all[i]?.function.p0 ?? all.at(-1)!.function.p3
        return `<circle class="curve-editor-key ${i === selected ? 'selected' : ''}" cx="${x(time)}" cy="${y(height)}" r="6" tabindex="0" role="button" aria-label="Key ${i + 1}, time ${number(time)}, value ${number(height)}" aria-pressed="${i === selected}" data-editor-key="${i}"/>`
      },
    ).join('')}</g>`
    for (const [name, n] of [
      ['time', current.time],
      ['value', current.height],
    ] as const)
      if (field(name) !== source) field(name).value = number(n)
    field('time').disabled = selected === 0 || selected === all.length
    dialog.querySelector<HTMLButtonElement>('[data-curve-tool="remove"]')!.disabled =
      selected === 0 || selected === all.length
  }

  function add(time?: number): void {
    const all = segments(value)
    if (time === undefined) {
      const largest = all.reduce(
        (best, s, i) =>
          (all[i + 1]?.start ?? 1) - s.start > (all[best + 1]?.start ?? 1) - all[best]!.start
            ? i
            : best,
        0,
      )
      time = (all[largest]!.start + (all[largest + 1]?.start ?? 1)) / 2
    }
    const index = insertCurveKey(value, time)
    if (index >= 0) selected = index
    render()
  }

  dialog.addEventListener('click', (event) => {
    const target = (event.target as Element).closest<HTMLElement>(
      '[data-curve-tool], [data-curve-preset], [data-editor-key]',
    )
    if (!target) return
    if (target.dataset.editorKey !== undefined) selected = Number(target.dataset.editorKey)
    else if (target.dataset.curvePreset !== undefined) {
      applyCurvePreset(value, Number(target.dataset.curvePreset))
      selected = 0
      ;[low, high] = curveBounds(value)
    } else {
      const tool = target.dataset.curveTool
      if (tool === 'fit') [low, high] = curveBounds(value)
      else if (tool === 'add') {
        add()
        return
      } else if (tool === 'remove') {
        if (removeCurveKey(value, selected)) selected--
      } else if (tool === 'flat' || tool === 'linear' || tool === 'smooth')
        setCurveTangent(value, selected, tool)
    }
    render()
  })
  dialog.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement
    if (!input.dataset.curveField || input.value === '' || !Number.isFinite(input.valueAsNumber))
      return
    const current = key()
    moveCurveKey(
      value,
      selected,
      input.dataset.curveField === 'time' ? input.valueAsNumber : current.time,
      input.dataset.curveField === 'value' ? input.valueAsNumber : current.height,
    )
    if (input.dataset.curveField === 'time' && key().time !== input.valueAsNumber)
      input.value = number(key().time)
    render(input)
  })
  svg.addEventListener('dblclick', (event) => {
    if ((event.target as Element).closest('[data-editor-key], [data-tangent-part]')) return
    add(coords(event).time)
  })
  svg.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      const center = coords(event).height,
        scale = Math.exp(clamp(event.deltaY, -200, 200) * 0.002)
      const span = clamp((high - low) * scale, 0.0001, 1e12)
      const fraction = (center - low) / (high - low)
      low = center - span * fraction
      high = low + span
      render()
    },
    { passive: false },
  )
  svg.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    const target = (event.target as Element).closest<SVGElement>(
      '[data-editor-key], [data-tangent-part]',
    )
    if (!target && !event.altKey) return
    event.preventDefault()
    if (target?.dataset.editorKey !== undefined) selected = Number(target.dataset.editorKey)
    const startY = event.clientY,
      startLow = low,
      startHigh = high
    const initial = coords(event),
      current = key()
    const rect = svg.getBoundingClientRect()
    const move = (pointer: PointerEvent) => {
      if (!dialog.isConnected) {
        end()
        return
      }
      if (!target) {
        const delta =
          ((((pointer.clientY - startY) * H) / rect.height) * (startHigh - startLow)) / (B - T)
        low = startLow + delta
        high = startHigh + delta
      } else {
        const next = coords(pointer)
        if (target.dataset.tangentPart) {
          const p = segments(value)[Number(target.dataset.tangentSegment)]!.function
          p[target.dataset.tangentPart as 'p1' | 'p2'] = next.height
        } else
          moveCurveKey(
            value,
            selected,
            current.time + next.time - initial.time,
            current.height + next.height - initial.height,
          )
      }
      render()
    }
    const end = () => {
      dialog.removeEventListener('pointermove', move)
      dialog.removeEventListener('pointerup', end)
      dialog.removeEventListener('pointercancel', end)
      dialog.removeEventListener('lostpointercapture', end)
    }
    dialog.setPointerCapture(event.pointerId)
    dialog.addEventListener('pointermove', move)
    dialog.addEventListener('pointerup', end)
    dialog.addEventListener('pointercancel', end)
    dialog.addEventListener('lostpointercapture', end)
    render()
  })
  svg.addEventListener('keydown', (event) => {
    const target = event.target as SVGElement
    const direction =
      event.key === 'ArrowUp' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowDown' || event.key === 'ArrowLeft'
          ? -1
          : 0
    if (target.dataset.editorKey !== undefined) {
      selected = Number(target.dataset.editorKey)
      if (event.key === 'Enter' || event.key === ' ') event.preventDefault()
      else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        if (removeCurveKey(value, selected)) selected--
      } else if (direction) {
        event.preventDefault()
        const current = key(),
          step = direction * (event.shiftKey ? 10 : 1)
        moveCurveKey(
          value,
          selected,
          current.time +
            (event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? step * 0.01 : 0),
          current.height +
            (event.key === 'ArrowUp' || event.key === 'ArrowDown'
              ? (step * (high - low)) / 100
              : 0),
        )
      } else return
      render()
      svg.querySelector<SVGElement>(`[data-editor-key="${selected}"]`)?.focus()
    } else if (
      target.dataset.tangentPart &&
      (event.key === 'ArrowUp' || event.key === 'ArrowDown')
    ) {
      event.preventDefault()
      const p = segments(value)[Number(target.dataset.tangentSegment)]!.function
      p[target.dataset.tangentPart as 'p1' | 'p2'] +=
        ((direction * (high - low)) / 100) * (event.shiftKey ? 10 : 1)
      render()
      svg.querySelector<SVGElement>(`[data-tangent-part="${target.dataset.tangentPart}"]`)?.focus()
    }
  })
  render()
}

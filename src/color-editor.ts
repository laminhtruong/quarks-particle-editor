import type { NativeRecord } from './native-properties.js'

type RGB = { r: number; g: number; b: number; a?: number }
type Part = 'color' | 'alpha'
type Key = { pos: number; value: RGB | number }
const clamp = (value: number): number => Math.max(0, Math.min(1, value))
const byte = (value: number): number => Math.round(clamp(value) * 255)
const channels = ['r', 'g', 'b', 'a'] as const
const rgbCss = (color: RGB): string => `rgb(${byte(color.r)} ${byte(color.g)} ${byte(color.b)})`
const rgbaCss = (color: RGB): string =>
  `rgb(${byte(color.r)} ${byte(color.g)} ${byte(color.b)} / ${clamp(color.a ?? 1)})`
const hex = (color: RGB): string =>
  channels
    .map((key) =>
      byte(color[key] ?? 1)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()

export function rgbToHsv({ r, g, b }: RGB): [number, number, number] {
  r = clamp(r)
  g = clamp(g)
  b = clamp(b)
  const max = Math.max(r, g, b)
  const delta = max - Math.min(r, g, b)
  const hue = !delta
    ? 0
    : max === r
      ? (g - b) / delta
      : max === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4
  return [(hue / 6 + 1) % 1, max ? delta / max : 0, max]
}

export function hsvToRgb(h: number, s: number, v: number): RGB {
  const channel = (offset: number) => {
    const k = (offset + h * 6) % 6
    return v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1)))
  }
  return { r: channel(5), g: channel(3), b: channel(1) }
}

export function parseColorHex(value: string): RGB | undefined {
  const text = value.trim().replace(/^#/, '')
  if (!/^(?:[\da-f]{6}|[\da-f]{8})$/i.test(text)) return
  const values = text.match(/../g)!.map((pair) => parseInt(pair, 16) / 255)
  return {
    r: values[0]!,
    g: values[1]!,
    b: values[2]!,
    ...(values.length === 4 ? { a: values[3]! } : {}),
  }
}

function keys(value: NativeRecord, part: Part): Key[] {
  return (value[part] as { keys: Key[] }).keys
}

export function sampleGradient(value: NativeRecord, pos: number): RGB {
  const sample = (part: Part): RGB | number => {
    const stops = [...keys(value, part)].sort((a, b) => a.pos - b.pos)
    const right = stops.findIndex((key) => key.pos > pos)
    if (right === 0) return stops[0]!.value
    if (right < 0) return stops.at(-1)!.value
    const before = stops[right - 1]!
    const after = stops[right]!
    const t = (pos - before.pos) / (after.pos - before.pos)
    if (part === 'alpha')
      return Number(before.value) + (Number(after.value) - Number(before.value)) * t
    const a = before.value as RGB
    const b = after.value as RGB
    return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t }
  }
  return { ...(sample('color') as RGB), a: sample('alpha') as number }
}

export function gradientCss(value: NativeRecord): string {
  // Include both tracks' breakpoints so alpha-only keys remain visible.
  const positions = [
    ...new Set([
      0,
      1,
      ...keys(value, 'color').map((key) => key.pos),
      ...keys(value, 'alpha').map((key) => key.pos),
    ]),
  ].sort((a, b) => a - b)
  // shortcut: CSS samples approximate independent RGB/alpha tracks; use canvas if banding appears.
  const samples = [
    ...new Set([...positions, ...Array.from({ length: 65 }, (_, i) => i / 64)]),
  ].sort((a, b) => a - b)
  return `linear-gradient(90deg,${samples.map((pos) => `${rgbaCss(sampleGradient(value, pos))} ${clamp(pos) * 100}%`).join(',')})`
}

export function colorEditorMarkup(type: 'color' | 'gradient'): string {
  return `<dialog class="color-editor-dialog ${type === 'gradient' ? 'is-gradient' : ''}" aria-label="${type === 'color' ? 'Color' : 'Gradient'} editor"><header><strong>${type === 'color' ? 'Color' : 'Gradient'}</strong><button class="color-editor-close" type="button" aria-label="Close" data-native-action="color-editor-cancel">&times;</button></header><div class="color-editor-body"></div><footer><button class="btn" type="button" data-native-action="color-editor-cancel">Cancel</button><button class="btn primary" type="button" data-native-action="color-editor-apply">Apply</button></footer></dialog>`
}

export function bindColorEditor(
  dialog: HTMLDialogElement,
  type: 'color' | 'gradient',
  value: NativeRecord,
): void {
  const body = dialog.querySelector<HTMLElement>('.color-editor-body')!
  const gradient = type === 'gradient'
  const alphaEnabled = !gradient && typeof value.a === 'number'
  let part: Part = 'color'
  let selected = gradient ? keys(value, part)[0]! : undefined
  const color = (): RGB => (gradient ? selected!.value : value) as RGB
  let hsv = rgbToHsv(color())
  let original = structuredClone(color())
  const $ = <T extends Element = HTMLElement>(selector: string) => body.querySelector<T>(selector)!
  const number = (n: number) => String(Number(n.toFixed(2)))

  function render(): void {
    const alpha = gradient && part === 'alpha'
    body.innerHTML = `${gradient ? `<div class="gradient-editor-track"><div class="gradient-key-rail alpha" data-key-rail="alpha" aria-label="Alpha keys"></div><div class="gradient-editor-preview checkerboard"><div data-gradient-preview></div></div><div class="gradient-key-rail color" data-key-rail="color" aria-label="Color keys"></div></div><div class="gradient-editor-controls"><span class="gradient-selection">${alpha ? 'Alpha' : 'Color'} key</span><label>Location <input type="number" min="0" max="100" step="0.1" aria-label="Key location percent" data-key-position> %</label><button class="btn small danger" type="button" data-picker-action="remove" aria-label="Remove selected key" ${keys(value, part).length <= 2 ? 'disabled' : ''}>&times;</button></div><div class="gradient-editor-tools"><button class="btn small" type="button" data-picker-action="add-color">+ Color key</button><button class="btn small" type="button" data-picker-action="add-alpha">+ Alpha key</button><span>Click a track to add · Drag keys to move</span></div>` : ''}
      ${
        alpha
          ? `<label class="color-channel"><span>A</span><input class="color-channel-range checkerboard" type="range" min="0" max="255" step="1" aria-label="Alpha" data-key-alpha><input type="number" min="0" max="255" step="1" aria-label="Alpha value" data-key-alpha></label>`
          : `<div class="color-editor-picker">
        <div class="color-editor-toolbar"><span class="color-editor-mode">RGB <span>0–255</span></span><div class="color-editor-comparison checkerboard" aria-label="Original and current color"><div data-color-original title="Original color"></div><div data-color-current title="Current color"></div></div></div>
        <div class="color-wheel" data-color-wheel><div class="color-hue-ring" data-picker-plane="hue" role="slider" tabindex="0" aria-label="Hue" aria-valuemin="0" aria-valuemax="360"><span class="color-hue-thumb"></span></div><div class="color-sv" data-picker-plane="sv"><span class="color-sv-thumb"></span></div></div>
        <div class="sr-only"><label>Saturation<input type="range" min="0" max="100" step="1" data-picker-sv="1"></label><label>Brightness<input type="range" min="0" max="100" step="1" data-picker-sv="2"></label></div>
        <div class="color-editor-channels">${channels
          .filter((key) => alphaEnabled || key !== 'a')
          .map(
            (key) =>
              `<label class="color-channel"><span>${key.toUpperCase()}</span><input class="color-channel-range ${key === 'a' ? 'checkerboard' : ''}" type="range" min="0" max="255" step="1" aria-label="${key.toUpperCase()} channel" data-picker-channel="${key}"><input type="number" min="0" max="255" step="1" aria-label="${key.toUpperCase()} value" data-picker-channel="${key}"></label>`,
          )
          .join('')}</div>
        <label class="color-editor-hex"><span>Hexadecimal</span><input type="text" maxlength="9" spellcheck="false" aria-label="Hexadecimal color" data-picker-hex></label>
      </div>`
      }`
    sync()
  }

  function sync(source?: HTMLInputElement): void {
    if (gradient) {
      $('[data-gradient-preview]').style.background = gradientCss(value)
      for (const track of ['alpha', 'color'] as const) {
        $(`[data-key-rail="${track}"]`).innerHTML = keys(value, track)
          .map(
            (key, index) =>
              `<button type="button" class="gradient-key ${selected === key ? 'selected' : ''}" style="left:${clamp(key.pos) * 100}%;--key-color:${track === 'alpha' ? rgbCss({ r: Number(key.value), g: Number(key.value), b: Number(key.value) }) : rgbCss(key.value as RGB)}" data-key-part="${track}" data-key-index="${index}" aria-label="${track === 'alpha' ? 'Alpha' : 'Color'} key ${index + 1}, ${number(key.pos * 100)} percent" aria-pressed="${selected === key}"></button>`,
          )
          .join('')
      }
      const position = $<HTMLInputElement>('[data-key-position]')
      if (position !== source) position.value = number(selected!.pos * 100)
      if (part === 'alpha') {
        for (const input of body.querySelectorAll<HTMLInputElement>('[data-key-alpha]')) {
          if (input !== source) input.value = String(byte(Number(selected!.value)))
          input.style.setProperty('--channel-gradient', 'linear-gradient(90deg,transparent,#fff)')
        }
        return
      }
    }
    const rgb = color()
    $('[data-color-original]').style.background = rgbaCss(original)
    $('[data-color-current]').style.background = rgbaCss(rgb)
    const wheel = $('[data-color-wheel]')
    wheel.style.setProperty('--hue-color', rgbCss(hsvToRgb(hsv[0], 1, 1)))
    wheel.style.setProperty('--hue-angle', `${-hsv[0] * 360}deg`)
    wheel.style.setProperty('--saturation', `${hsv[1] * 100}%`)
    wheel.style.setProperty('--brightness', `${(1 - hsv[2]) * 100}%`)
    $('[data-picker-plane="hue"]').setAttribute('aria-valuenow', number(hsv[0] * 360))
    for (const input of body.querySelectorAll<HTMLInputElement>('[data-picker-sv]')) {
      if (input !== source)
        input.value = String(Math.round(hsv[Number(input.dataset.pickerSv)]! * 100))
    }
    for (const input of body.querySelectorAll<HTMLInputElement>('[data-picker-channel]')) {
      const key = input.dataset.pickerChannel as keyof RGB
      if (input !== source) input.value = String(byte(rgb[key] ?? 1))
      input.style.setProperty(
        '--channel-gradient',
        `linear-gradient(90deg,${key === 'a' ? 'transparent' : rgbCss({ ...rgb, [key]: 0 })},${rgbCss({ ...rgb, [key]: 1 })})`,
      )
    }
    const hexInput = $<HTMLInputElement>('[data-picker-hex]')
    if (hexInput !== source) {
      hexInput.value = alphaEnabled ? hex(rgb) : hex(rgb).slice(0, 6)
      hexInput.removeAttribute('aria-invalid')
    }
  }

  function select(track: Part, key: Key): void {
    part = track
    selected = key
    if (part === 'color') {
      hsv = rgbToHsv(color())
      original = structuredClone(color())
    }
    render()
  }

  function add(track: Part, pos?: number): void {
    const stops = keys(value, track)
    if (pos === undefined) {
      const positions = [0, ...stops.map((key) => key.pos), 1]
      let gap = 0
      pos = 0.5
      for (let i = 1; i < positions.length; i++) {
        const span = positions[i]! - positions[i - 1]!
        if (span > gap) {
          gap = span
          pos = (positions[i]! + positions[i - 1]!) / 2
        }
      }
    }
    const existing = stops.find((key) => Math.abs(key.pos - pos!) < 0.001)
    if (existing) {
      select(track, existing)
      return
    }
    const sampled = sampleGradient(value, pos)
    const key: Key = {
      pos,
      value: track === 'alpha' ? sampled.a! : { r: sampled.r, g: sampled.g, b: sampled.b },
    }
    keys(value, track).push(key)
    keys(value, track).sort((a, b) => a.pos - b.pos)
    select(track, key)
  }

  function moveKey(pos: number, source?: HTMLInputElement): void {
    const stops = keys(value, part)
    const index = stops.indexOf(selected!)
    const min =
      index > 0
        ? stops[index - 1]!.pos + Math.min(0.001, (selected!.pos - stops[index - 1]!.pos) / 2)
        : 0
    const max =
      index < stops.length - 1
        ? stops[index + 1]!.pos - Math.min(0.001, (stops[index + 1]!.pos - selected!.pos) / 2)
        : 1
    selected!.pos = Math.max(min, Math.min(max, pos))
    if (source && selected!.pos !== pos) source.value = number(selected!.pos * 100)
    keys(value, part).sort((a, b) => a.pos - b.pos)
    sync(source)
  }

  function setHsv(): void {
    Object.assign(color(), hsvToRgb(...hsv))
    sync()
  }

  body.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement
    if (input.dataset.pickerHex !== undefined) {
      const parsed = parseColorHex(input.value)
      input.setAttribute('aria-invalid', String(!parsed))
      if (!parsed) return
      if (!alphaEnabled) delete parsed.a
      Object.assign(color(), parsed)
      const next = rgbToHsv(color())
      hsv = [next[1] ? next[0] : hsv[0], next[1], next[2]]
    } else {
      if (input.value === '' || !Number.isFinite(input.valueAsNumber)) return
      const n = input.valueAsNumber
      if (input.dataset.keyPosition !== undefined) {
        moveKey(n / 100, input)
        return
      }
      if (input.dataset.keyAlpha !== undefined) selected!.value = clamp(n / 255)
      else if (input.dataset.pickerSv) {
        hsv[Number(input.dataset.pickerSv)] = clamp(n / 100)
        Object.assign(color(), hsvToRgb(...hsv))
      } else if (input.dataset.pickerChannel) {
        const channel = input.dataset.pickerChannel as keyof RGB
        color()[channel] = clamp(n / 255)
        if (channel !== 'a') {
          const next = rgbToHsv(color())
          hsv = [next[1] ? next[0] : hsv[0], next[1], next[2]]
        }
      } else return
    }
    sync(input)
  })

  body.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-picker-action], [data-key-part]',
    )
    if (!target) return
    if (target.dataset.keyPart) {
      select(
        target.dataset.keyPart as Part,
        keys(value, target.dataset.keyPart as Part)[Number(target.dataset.keyIndex)]!,
      )
      return
    }
    const action = target.dataset.pickerAction
    if (action === 'remove') {
      const stops = keys(value, part)
      if (stops.length <= 2) return
      stops.splice(stops.indexOf(selected!), 1)
      select(part, stops[0]!)
    } else if (action === 'add-color' || action === 'add-alpha')
      add(action === 'add-color' ? 'color' : 'alpha')
  })

  body.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    const plane = target.closest<HTMLElement>('[data-picker-plane]')
    const rail = target.closest<HTMLElement>('[data-key-rail]')
    if (!plane && !rail) return
    event.preventDefault()
    const rect = (plane ?? rail)!.getBoundingClientRect()
    if (rail) {
      const track = rail.dataset.keyRail as Part
      const handle = target.closest<HTMLElement>('[data-key-part]')
      if (handle) select(track, keys(value, track)[Number(handle.dataset.keyIndex)]!)
      else add(track, clamp((event.clientX - rect.left) / rect.width))
    } else plane!.focus()
    const move = (pointer: PointerEvent) => {
      if (rail) moveKey((pointer.clientX - rect.left) / rect.width)
      else if (plane!.dataset.pickerPlane === 'hue') {
        hsv[0] =
          (-Math.atan2(
            pointer.clientY - rect.top - rect.height / 2,
            pointer.clientX - rect.left - rect.width / 2,
          ) /
            (2 * Math.PI) +
            1) %
          1
        setHsv()
      } else {
        hsv[1] = clamp((pointer.clientX - rect.left) / rect.width)
        hsv[2] = 1 - clamp((pointer.clientY - rect.top) / rect.height)
        setHsv()
      }
    }
    dialog.setPointerCapture(event.pointerId)
    move(event)
    const end = () => {
      dialog.removeEventListener('pointermove', move)
      dialog.removeEventListener('pointerup', end)
      dialog.removeEventListener('pointercancel', end)
      dialog.removeEventListener('lostpointercapture', end)
    }
    dialog.addEventListener('pointermove', move)
    dialog.addEventListener('pointerup', end)
    dialog.addEventListener('pointercancel', end)
    dialog.addEventListener('lostpointercapture', end)
  })

  body.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement
    const direction =
      event.key === 'ArrowRight' || event.key === 'ArrowUp'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
          ? -1
          : 0
    if (target.dataset.pickerPlane === 'hue' && direction) {
      event.preventDefault()
      hsv[0] = (hsv[0] + (direction * (event.shiftKey ? 10 : 1)) / 360 + 1) % 1
      setHsv()
    } else if (target.dataset.keyPart && direction) {
      event.preventDefault()
      const track = target.dataset.keyPart as Part
      const key = keys(value, track)[Number(target.dataset.keyIndex)]!
      if (selected !== key) select(track, key)
      moveKey(key.pos + direction * (event.shiftKey ? 0.1 : 0.01))
      $<HTMLButtonElement>(
        `[data-key-part="${track}"][data-key-index="${keys(value, track).indexOf(key)}"]`,
      ).focus()
    }
  })
  render()
}

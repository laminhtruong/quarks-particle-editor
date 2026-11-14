import {
  AxisAngleGenerator,
  BehaviorTypes,
  ColorRange,
  ConstantColor,
  ConstantValue,
  EmitterShapes,
  EulerGenerator,
  Gradient,
  IntervalValue,
  ParticleSystem,
  PiecewiseBezier,
  RandomColor,
  RandomColorBetweenGradient,
  RandomQuatGenerator,
  Vector3,
  Vector3Function,
  Vector4,
} from 'three.quarks'
import type { QuarksDocument } from './document.js'

export type NativeRecord = Record<string, unknown>
export type NativePath = (string | number)[]

const constant = () => new ConstantValue(1)
const gradient = () =>
  new Gradient([
    [new Vector3(1, 1, 1), 0],
    [new Vector3(1, 1, 1), 1],
  ])
const white = () => new Vector4(1, 1, 1, 1)

export const generatorTemplates: Record<string, () => NativeRecord> = {
  ConstantValue: () => constant().toJSON(),
  IntervalValue: () => new IntervalValue(0, 1).toJSON(),
  PiecewiseBezier: () => new PiecewiseBezier().toJSON(),
  ConstantColor: () => new ConstantColor(white()).toJSON(),
  ColorRange: () => new ColorRange(white(), white()).toJSON(),
  RandomColor: () => new RandomColor(white(), white()).toJSON(),
  Gradient: () => gradient().toJSON(),
  RandomColorBetweenGradient: () => new RandomColorBetweenGradient(gradient(), gradient()).toJSON(),
  AxisAngle: () => new AxisAngleGenerator(new Vector3(0, 0, 1), constant()).toJSON(),
  Euler: () => new EulerGenerator(constant(), constant(), constant()).toJSON(),
  RandomQuat: () => new RandomQuatGenerator().toJSON(),
  Vector3Function: () => new Vector3Function(constant(), constant(), constant()).toJSON(),
}

const scalarTypes = ['ConstantValue', 'IntervalValue', 'PiecewiseBezier']
const colorTypes = [
  'ConstantColor',
  'ColorRange',
  'RandomColor',
  'Gradient',
  'RandomColorBetweenGradient',
]
const rotationTypes = ['AxisAngle', 'Euler', 'RandomQuat']

export function generatorChoices(path: NativePath, owner?: NativeRecord): string[] {
  const key = String(path.at(-1))
  if (key === 'speedRange') return ['IntervalValue']
  if (key === 'gradient1' || key === 'gradient2') return ['Gradient']
  if (key === 'startColor' || (key === 'color' && owner?.type !== 'Gradient')) return colorTypes
  if (key === 'startRotation') return [...scalarTypes, ...rotationTypes]
  if (key === 'angularVelocity' && owner?.type === 'Rotation3DOverLife') return rotationTypes
  if (key === 'startSize' || key === 'size') return [...scalarTypes, 'Vector3Function']
  return scalarTypes
}

export function newBehavior(type: string, system: ParticleSystem): NativeRecord {
  if (!Object.hasOwn(BehaviorTypes, type))
    throw new Error(`Behavior is not registered by Quarks: ${type}`)
  const plugin = BehaviorTypes[type]
  if (!plugin) throw new Error(`Behavior is not registered by Quarks: ${type}`)
  const args = plugin.params.map(([name, kinds]) => {
    if (type === 'Noise' && name === 'rotationAmount') return new ConstantValue(0)
    switch (kinds[0]) {
      case 'self':
        return system
      case 'vec3':
        return new Vector3(1, 1, 1)
      case 'range':
        return new IntervalValue(0, 10)
      case 'colorFunc':
        return gradient()
      case 'rotationFunc':
        return new EulerGenerator(constant(), constant(), constant())
      case 'boolean':
        return false
      case 'particleSystem':
        return undefined
      case 'number':
        return name === 'mode' ? 0 : 1
      default:
        return constant()
    }
  })
  return new plugin.constructor(...args).toJSON() as NativeRecord
}

export function newShape(type: string): NativeRecord {
  if (!Object.hasOwn(EmitterShapes, type))
    throw new Error(`Shape is not registered by Quarks: ${type}`)
  const plugin = EmitterShapes[type]
  if (!plugin) throw new Error(`Shape is not registered by Quarks: ${type}`)
  const json = { ...new plugin.constructor().toJSON() }
  if (type === 'mesh_surface') return { type, geometry: '' }
  return json
}

export function nativeNode(json: QuarksDocument, index: number): NativeRecord {
  const nodes: NativeRecord[] = []
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    const node = value as NativeRecord
    if (node.type === 'ParticleEmitter') nodes.push(node)
    if (Array.isArray(node.children)) node.children.forEach(visit)
  }
  visit(json.object)
  const node = nodes[index]
  if (!node) throw new Error('Select a particle system first.')
  return node
}

export function prepareNativeDocument(json: QuarksDocument): void {
  const generator = (value: unknown, allowed: string[], name: string) => {
    if (
      !value ||
      typeof value !== 'object' ||
      !allowed.includes(String((value as NativeRecord).type))
    )
      throw new Error(`Unsupported ${name} generator. The document was not changed.`)
  }
  const visit = (node: NativeRecord) => {
    if (node.type === 'ParticleEmitter') {
      const ps = node.ps as NativeRecord
      if (!ps || !Array.isArray(ps.behaviors)) throw new Error('Invalid Quarks particle system.')
      const shape = ps.shape as NativeRecord
      if (!shape || !Object.hasOwn(EmitterShapes, String(shape.type)))
        throw new Error(`Unregistered emitter shape: ${String(shape?.type)}`)
      if (shape.type === 'mesh_surface' && !shape.geometry && shape.mesh)
        shape.geometry = shape.mesh
      for (const key of ['startLife', 'startSpeed', 'emissionOverTime', 'emissionOverDistance'])
        generator(ps[key], scalarTypes, key)
      generator(ps.startSize, [...scalarTypes, 'Vector3Function'], 'startSize')
      generator(ps.startRotation, [...scalarTypes, ...rotationTypes], 'startRotation')
      generator(ps.startColor, colorTypes, 'startColor')
      if (ps.layers === 0)
        throw new Error('Quarks 0.17.1 cannot restore layer mask 0. Use a nonzero layer mask.')
      if (typeof ps.startTileIndex !== 'number')
        generator(ps.startTileIndex, scalarTypes, 'startTileIndex')
      if (shape.speed) generator(shape.speed, scalarTypes, 'shape speed')
      for (const behavior of ps.behaviors as NativeRecord[]) {
        if (!Object.hasOwn(BehaviorTypes, String(behavior.type)))
          throw new Error(
            `Quarks cannot load behavior ${String(behavior.type)} from JSON. The document was not changed.`,
          )
        const rotationAmount = behavior.rotationAmount as NativeRecord | undefined
        const zeroRotation =
          (rotationAmount?.type === 'ConstantValue' && rotationAmount.value === 0) ||
          (rotationAmount?.type === 'IntervalValue' &&
            rotationAmount.a === 0 &&
            rotationAmount.b === 0) ||
          (rotationAmount?.type === 'PiecewiseBezier' &&
            Array.isArray(rotationAmount.functions) &&
            rotationAmount.functions.length > 0 &&
            rotationAmount.functions.every((item) =>
              ['p0', 'p1', 'p2', 'p3'].every((key) => item.function?.[key] === 0),
            ))
        for (const [name, kinds] of BehaviorTypes[String(behavior.type)]!.params) {
          if (kinds.includes('colorFunc')) generator(behavior[name], colorTypes, name)
          else if (kinds.includes('rotationFunc')) generator(behavior[name], rotationTypes, name)
          else if (kinds.includes('range')) generator(behavior[name], ['IntervalValue'], name)
          else if (kinds.includes('value') || kinds.includes('valueFunc'))
            generator(
              behavior[name],
              kinds.includes('vec3Func') ? [...scalarTypes, 'Vector3Function'] : scalarTypes,
              name,
            )
        }
        if (ps.renderMode === 3 && behavior.type === 'Noise' && !zeroRotation) {
          throw new Error(
            'Quarks trails have no rotation: Noise Rotation Amount must evaluate to 0 in Trail mode.',
          )
        }
      }
      validateNative(ps)
      behaviorSlots(node)
    }
    if (Array.isArray(node.children)) (node.children as NativeRecord[]).forEach(visit)
  }
  validateNative(json.materials)
  validateNative(json.textures)
  visit(json.object)
}

export function getNativeValue(value: unknown, path: NativePath): unknown {
  for (const key of path) {
    if (
      key === '__proto__' ||
      key === 'prototype' ||
      key === 'constructor' ||
      !value ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, key)
    ) {
      throw new Error('Invalid property path.')
    }
    value = (value as NativeRecord)[key]
  }
  return value
}

export function setNativeValue(root: NativeRecord, path: NativePath, value: unknown): void {
  if (!path.length) throw new Error('Cannot replace the document root.')
  getNativeValue(root, path)
  const owner = getNativeValue(root, path.slice(0, -1)) as NativeRecord
  owner[path.at(-1)!] = value
}

/** Disabled modules stay in standard Object3D userData; the runtime sees only enabled behaviors. */
export function behaviorSlots(node: NativeRecord): { enabled: boolean; value: NativeRecord }[] {
  const ps = node.ps as NativeRecord
  const active = [...(ps.behaviors as NativeRecord[])]
  const disabled = ((node.userData as NativeRecord | undefined)?.quarksEditorDisabled ?? []) as {
    index: number
    value: NativeRecord
  }[]
  const slots = active.map((value) => ({ enabled: true, value }))
  for (const item of [...disabled].sort((a, b) => a.index - b.index)) {
    if (
      !Number.isInteger(item.index) ||
      item.index < 0 ||
      item.index > slots.length ||
      !item.value ||
      typeof item.value.type !== 'string'
    )
      throw new Error('Invalid disabled behavior metadata.')
    slots.splice(item.index, 0, { enabled: false, value: item.value })
  }
  return slots
}

export function writeBehaviorSlots(
  node: NativeRecord,
  slots: ReturnType<typeof behaviorSlots>,
): void {
  ;(node.ps as NativeRecord).behaviors = slots
    .filter((slot) => slot.enabled)
    .map((slot) => slot.value)
  const userData = (node.userData ??= {}) as NativeRecord
  userData.quarksEditorDisabled = slots.flatMap((slot, index) =>
    slot.enabled ? [] : [{ index, value: slot.value }],
  )
}

const escape = (value: unknown) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
export const propertyLabel = (name: string) =>
  name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replace(/^./, (letter) => letter.toUpperCase())
const attr = (path: NativePath) => escape(JSON.stringify(path))
const options = (values: readonly (readonly [string | number, string])[], current: unknown) =>
  values
    .map(
      ([value, label]) =>
        `<option value="${escape(value)}" ${String(current) === String(value) ? 'selected' : ''}>${escape(label)}</option>`,
    )
    .join('')

export interface PropertyContext {
  emitters: { uuid: string; name: string }[]
  geometries: { uuid: string; name: string }[]
  materials: { uuid: string; name: string }[]
  textures?: { uuid: string; name: string }[]
}

function select(
  path: NativePath,
  label: string,
  values: readonly (readonly [string | number, string])[],
  value: unknown,
  numeric = false,
): string {
  return `<label class="field"><span>${escape(label)}</span><select data-native-path="${attr(path)}" data-native-kind="${numeric ? 'number' : 'string'}">${options(values, value)}</select></label>`
}

export function renderProperty(
  value: unknown,
  path: NativePath,
  context: PropertyContext,
  owner?: NativeRecord,
): string {
  const key = String(path.at(-1))
  const label = propertyLabel(key)
  const input = (type: string, current: unknown) =>
    `<label class="field"><span>${escape(label)}</span><input type="${type}" ${type === 'checkbox' ? (current ? 'checked' : '') : `value="${escape(current)}"`} ${type === 'number' ? 'step="any"' : ''} data-native-path="${attr(path)}" data-native-kind="${typeof current}"></label>`
  if (typeof value === 'number') {
    if (key === 'color' && typeof owner?.type === 'string' && owner.type.endsWith('Material'))
      return `<label class="field"><span>Color</span><input type="color" value="#${value.toString(16).padStart(6, '0')}" data-native-path="${attr(path)}" data-native-kind="hex"></label>`
    if (key === 'blending')
      return select(
        path,
        label,
        [
          [0, 'None'],
          [1, 'Normal'],
          [2, 'Additive'],
          [3, 'Subtractive'],
          [4, 'Multiply'],
          [5, 'Custom'],
        ],
        value,
        true,
      )
    if (key === 'side')
      return select(
        path,
        label,
        [
          [0, 'Front'],
          [1, 'Back'],
          [2, 'Double'],
        ],
        value,
        true,
      )
    if (key === 'mode' && owner?.type === 'EmitSubParticleSystem')
      return select(
        path,
        'Trigger',
        [
          [0, 'Death'],
          [1, 'Birth'],
          [2, 'Frame'],
        ],
        value,
        true,
      )
    if (key === 'mode')
      return select(
        path,
        'Emission Mode',
        [
          [0, 'Random'],
          [1, 'Loop'],
          [2, 'Ping Pong'],
          [3, 'Burst'],
        ],
        value,
        true,
      )
    return input('number', value)
  }
  if (typeof value === 'boolean') return input('checkbox', value)
  if (typeof value === 'string') {
    if ((key === 'map' || key.endsWith('Map')) && context.textures)
      return select(
        path,
        label,
        [['', 'None'], ...context.textures.map((item) => [item.uuid, item.name] as const)],
        value,
      )
    if (key === 'subParticleSystem')
      return select(
        path,
        'Sub Emitter',
        [['', 'None'], ...context.emitters.map((item) => [item.uuid, item.name] as const)],
        value,
      )
    if (key === 'geometry' || key === 'instancingGeometry' || key === 'mesh')
      return select(
        path,
        'Geometry',
        [['', 'None'], ...context.geometries.map((item) => [item.uuid, item.name] as const)],
        value,
      )
    if (key === 'material')
      return select(
        path,
        label,
        context.materials.map((item) => [item.uuid, item.name] as const),
        value,
      )
    if (key === 'eulerOrder')
      return select(
        path,
        'Euler Order',
        ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'].map((item) => [item, item] as const),
        value,
      )
    return input('text', value)
  }
  if (Array.isArray(value)) {
    const editable = ['emissionBursts', 'functions', 'keys'].includes(key)
    return `<fieldset class="native-group"><legend>${escape(label)}</legend>${value.map((item, index) => `<div class="native-array-item">${renderProperty(item, [...path, index], context, owner)}${editable ? `<button class="btn small danger" type="button" data-native-action="remove" data-native-path="${attr([...path, index])}">Remove ${index + 1}</button>` : ''}</div>`).join('')}${editable ? `<button class="btn small" type="button" data-native-action="append" data-native-path="${attr(path)}">+ ${key === 'emissionBursts' ? 'Burst' : key === 'keys' ? 'Key' : 'Curve segment'}</button>` : ''}</fieldset>`
  }
  if (!value || typeof value !== 'object') return ''
  const object = value as NativeRecord
  const type = typeof object.type === 'string' ? object.type : ''
  let typeControl = ''
  if (Object.hasOwn(generatorTemplates, type)) {
    const choices = generatorChoices(path, owner)
    typeControl = `<label class="field"><span>Mode</span><select data-native-action="generator" data-native-path="${attr(path)}">${options(
      choices.map((item) => [item, propertyLabel(item)]),
      type,
    )}</select></label>`
  } else if (key === 'shape') {
    typeControl = `<label class="field"><span>Shape</span><select data-native-action="shape" data-native-path="${attr(path)}">${options(
      Object.keys(EmitterShapes).map((item) => [item, propertyLabel(item)]),
      type,
    )}</select></label>`
  }
  let preview = ''
  if (type === 'PiecewiseBezier') {
    const curve = PiecewiseBezier.fromJSON(object)
    const samples = Array.from({ length: 65 }, (_, index) => curve.genValue([], index / 64))
    const low = Math.min(0, ...samples),
      high = Math.max(1, ...samples)
    const points = samples
      .map((sample, index) => `${(index * 100) / 64},${95 - ((sample - low) * 90) / (high - low)}`)
      .join(' ')
    preview = `<svg class="native-curve" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Bezier curve preview"><polyline points="${points}"/></svg><p class="hint">Cubic control values P0-P3; segment starts use normalized lifetime. Native angles use radians.</p>`
  }
  if (type === 'Gradient') {
    const color = object.color as NativeRecord
    const keys = color?.keys as
      { value: { r: number; g: number; b: number }; pos: number }[] | undefined
    if (keys?.length)
      preview = `<div class="native-gradient" role="img" aria-label="Color gradient preview" style="background:linear-gradient(to right,${keys.map((item) => `rgb(${Math.round(item.value.r * 255)},${Math.round(item.value.g * 255)},${Math.round(item.value.b * 255)}) ${item.pos * 100}%`).join(',')})"></div>`
  }
  const color = ['r', 'g', 'b'].every((channel) => typeof object[channel] === 'number')
  const swatch = color
    ? `<label class="field"><span>Color</span><input type="color" value="#${['r', 'g', 'b']
        .map((channel) =>
          Math.round(Math.max(0, Math.min(1, Number(object[channel]))) * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')}" data-native-color="${attr(path)}"></label>`
    : ''
  return `<fieldset class="native-group"><legend>${escape(label)}</legend>${typeControl}${preview}${swatch}${Object.entries(
    object,
  )
    .filter(([name]) => !['type', 'uuid', 'metadata', 'subType'].includes(name))
    .map(([name, item]) => renderProperty(item, [...path, name], context, object))
    .join('')}</fieldset>`
}

export function preserveNativeAssets(previous: QuarksDocument, next: QuarksDocument): void {
  const merge = (key: string, filter: (item: NativeRecord) => boolean = () => true) => {
    const items = new Map<string, NativeRecord>()
    for (const item of (previous[key] ?? []) as NativeRecord[])
      if (filter(item)) items.set(String(item.uuid), item)
    for (const item of (next[key] ?? []) as NativeRecord[]) items.set(String(item.uuid), item)
    if (items.size) next[key] = [...items.values()]
  }
  merge('geometries')
  merge('materials')
  const references = new Set<string>()
  const collect = (value: unknown) => {
    if (typeof value === 'string') references.add(value)
    else if (value && typeof value === 'object') Object.values(value).forEach(collect)
  }
  collect(next.materials)
  merge('textures', (item) => references.has(String(item.uuid)))
  references.clear()
  collect(next.textures)
  merge('images', (item) => references.has(String(item.uuid)))
}

export function renderProperties(
  object: NativeRecord,
  keys: string[],
  context: PropertyContext,
  prefix: NativePath = ['ps'],
): string {
  return keys
    .filter((key) => Object.hasOwn(object, key))
    .map((key) => renderProperty(object[key], [...prefix, key], context, object))
    .join('')
}

export function appendNativeItem(root: NativeRecord, path: NativePath): void {
  const array = getNativeValue(root, path)
  if (!Array.isArray(array)) throw new Error('Select a list.')
  const key = path.at(-1)
  if (key === 'emissionBursts')
    array.push({
      time: 0,
      count: { type: 'ConstantValue', value: 10 },
      cycle: 1,
      interval: 0.1,
      probability: 1,
    })
  else if (key === 'keys' || key === 'functions') {
    const timeKey = key === 'keys' ? 'pos' : 'start'
    const sorted = [...array].sort((a, b) => a[timeKey] - b[timeKey])
    let start = 0,
      end = 1
    for (let index = 0; index < sorted.length; index++) {
      const a = sorted[index][timeKey],
        b = sorted[index + 1]?.[timeKey] ?? 1
      if (b - a > end - start || index === 0) {
        start = a
        end = b
      }
    }
    if (end - start < 0.000001) throw new Error('No space for another key.')
    const previous = sorted.find((item) => item[timeKey] === start)!
    const following = sorted.find((item) => item[timeKey] === end)
    const item = structuredClone(previous)
    item[timeKey] = (start + end) / 2
    if (key === 'functions') {
      const { p0, p1, p2, p3 } = previous.function
      const a = (p0 + p1) / 2,
        b = (p1 + p2) / 2,
        c = (p2 + p3) / 2
      const d = (a + b) / 2,
        e = (b + c) / 2,
        middle = (d + e) / 2
      previous.function = { ...previous.function, p0, p1: a, p2: d, p3: middle }
      item.function = { ...item.function, p0: middle, p1: e, p2: c, p3 }
    } else if (following) {
      if (typeof previous.value === 'number') item.value = (previous.value + following.value) / 2
      else
        for (const channel of Object.keys(previous.value))
          item.value[channel] = (previous.value[channel] + following.value[channel]) / 2
    }
    array.push(item)
    array.sort((a, b) => a[timeKey] - b[timeKey])
  } else throw new Error('This array has a fixed length.')
}

/** Reject invalid edits before the live scene is replaced. */
export function validateNative(value: unknown, path: NativePath = []): void {
  const key = String(path.at(-1))
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Numbers must be finite.')
    if (
      [
        'duration',
        'uTileCount',
        'vTileCount',
        'cycle',
        'row',
        'rows',
        'column',
        'octaves',
      ].includes(key) &&
      value <= 0
    )
      throw new Error(`${propertyLabel(key)} must be positive.`)
    if (
      [
        'uTileCount',
        'vTileCount',
        'cycle',
        'rows',
        'column',
        'octaves',
        'layers',
        'renderOrder',
      ].includes(key) &&
      !Number.isInteger(value)
    )
      throw new Error(`${propertyLabel(key)} must be an integer.`)
    if (
      ['probability', 'emitProbability', 'dampen', 'thickness', 'pos', 'start'].includes(key) &&
      (value < 0 || value > 1)
    )
      throw new Error(`${propertyLabel(key)} must be between 0 and 1.`)
    if (
      ['time', 'interval', 'radius', 'donutRadius', 'softNearFade', 'softFarFade'].includes(key) &&
      value < 0
    )
      throw new Error(`${propertyLabel(key)} cannot be negative.`)
  }
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    if (['keys', 'functions'].includes(key)) {
      if (!value.length) throw new Error('A curve or gradient needs at least one key.')
      const timeKey = key === 'keys' ? 'pos' : 'start'
      for (let index = 1; index < value.length; index++)
        if (value[index][timeKey] <= value[index - 1][timeKey])
          throw new Error('Key times must be strictly increasing.')
    }
    value.forEach((item, index) => validateNative(item, [...path, index]))
  } else {
    const object = value as NativeRecord
    if (object.type === 'IntervalValue' && Number(object.a) > Number(object.b))
      throw new Error('Minimum must not exceed maximum.')
    if (key === 'speedRange' && Number(object.a) >= Number(object.b))
      throw new Error('Speed range maximum must exceed minimum.')
    for (const [name, item] of Object.entries(object)) validateNative(item, [...path, name])
  }
}

import { describe, expect, it } from 'vitest'
import { BoxGeometry, Group, MeshBasicMaterial } from 'three'
import {
  BatchedRenderer,
  BehaviorFromJSON,
  BehaviorTypes,
  ColorGeneratorFromJSON,
  EmitterShapes,
  GeneratorFromJSON,
  MeshSurfaceEmitter,
  ParticleSystem,
  PiecewiseBezier,
  QuarksLoader,
} from 'three.quarks'
import type { FunctionJSON } from 'three.quarks'
import {
  appendNativeItem,
  behaviorSlots,
  generatorChoices,
  generatorTemplates,
  getNativeValue,
  nativeNode,
  newBehavior,
  newShape,
  prepareNativeDocument,
  preserveNativeAssets,
  renderProperties,
  renderProperty,
  setNativeValue,
  validateNative,
  writeBehaviorSlots,
} from '../src/native-properties'
import type { NativeRecord, PropertyContext } from '../src/native-properties'
import { parseQuarksDocument } from '../src/document'
import { particlePreviewDuration } from '../src/preview'

const context: PropertyContext = { emitters: [], geometries: [], materials: [] }
const makeSystem = () =>
  new ParticleSystem({ material: new MeshBasicMaterial(), autoDestroy: false })

describe('installed Quarks catalog', () => {
  it.each(Object.keys(BehaviorTypes))(
    'creates, edits, loads, and simulates registered behavior %s',
    (type) => {
      const system = makeSystem()
      const json = newBehavior(type, system)
      validateNative(json)
      const behavior = BehaviorFromJSON(json, system)!
      expect(behavior.type).toBe(type)
      expect(behavior.toJSON()).toEqual(json)
      const fields = renderProperties(
        json,
        Object.keys(json).filter((key) => key !== 'type'),
        context,
      )
      expect(fields).toContain('data-native-')
      system.behaviors = [behavior]
      const batch = new BatchedRenderer()
      batch.addSystem(system)
      for (let index = 0; index < 12; index++) batch.update(1 / 60)
      for (const particle of system.particles) {
        expect(
          [particle.position.x, particle.position.y, particle.position.z].every(Number.isFinite),
        ).toBe(true)
      }
      system.dispose()
      system.material.dispose()
    },
  )

  it.each(Object.keys(EmitterShapes))('exposes every serialized parameter for shape %s', (type) => {
    const json = newShape(type)
    validateNative(json)
    const fields = renderProperty(json, ['ps', 'shape'], context)
    for (const key of Object.keys(json).filter((key) => key !== 'type')) {
      expect(fields).toContain(`&quot;${key}&quot;`)
    }
    expect(fields).toContain(`value="${type}" selected`)
  })

  it('labels every serialized behavior vector component with its axis', () => {
    const system = makeSystem()
    let checked = 0
    for (const [type, plugin] of Object.entries(BehaviorTypes)) {
      const behavior = newBehavior(type, system)
      for (const [key, kinds] of plugin.params) {
        if (!kinds.includes('vec3') || !Array.isArray(behavior[key])) continue
        const fields = renderProperties(behavior, [key], context, ['ps', 'behaviors', 0])
        for (const axis of ['X', 'Y', 'Z']) expect(fields).toContain(`<span>${axis}</span>`)
        expect(fields).not.toMatch(/<span>[0-2]<\/span>/)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(0)
    system.dispose()
    system.material.dispose()
  })

  it('names array entries instead of exposing raw zero-based indices', () => {
    for (const [key, label] of [
      ['emissionBursts', 'Burst 1'],
      ['functions', 'Curve Segment 1'],
      ['keys', 'Key 1'],
      ['other', 'Element 1'],
    ] as const) {
      const fields = renderProperty([{ value: 1 }], ['ps', key], context)
      expect(fields).toContain(`<legend>${label}</legend>`)
      expect(fields).not.toContain('<legend>0</legend>')
    }
  })

  it.each(Object.keys(generatorTemplates))(
    'round-trips generator %s without flattening its values',
    (type) => {
      const json = generatorTemplates[type]!()
      validateNative(json)
      const color = [
        'ConstantColor',
        'ColorRange',
        'RandomColor',
        'Gradient',
        'RandomColorBetweenGradient',
      ].includes(type)
      const generator = color
        ? ColorGeneratorFromJSON(json as FunctionJSON)
        : GeneratorFromJSON(json as FunctionJSON)
      expect(generator.toJSON()).toEqual(json)
      const fields = renderProperty(
        json,
        ['ps', color ? 'startColor' : type === 'Vector3Function' ? 'startSize' : 'startRotation'],
        context,
      )
      expect(fields).toContain(`value="${type}" selected`)
    },
  )

  it('offers only scalar generators inside a vector component and full rotation modes at the root', () => {
    expect(generatorChoices(['ps', 'startSize', 'x'])).not.toContain('Vector3Function')
    expect(generatorChoices(['ps', 'startRotation'])).toContain('RandomQuat')
    expect(
      generatorChoices(['ps', 'behaviors', 0, 'angularVelocity'], { type: 'Rotation3DOverLife' }),
    ).toEqual(['AxisAngle', 'Euler', 'RandomQuat'])
  })

  it('renders scalar generators compactly with the mode beside the property name', () => {
    const fields = renderProperty(generatorTemplates.IntervalValue!(), ['ps', 'startLife'], context)
    expect(fields).toContain('class="native-generator"')
    expect(fields).toContain('<span class="native-generator-label">Start Life</span>')
    expect(fields).toContain('class="native-generator-mode"')
    expect(fields).toContain('Random Between Two Constants')
    expect(fields).not.toContain('<span>A</span>')
    expect(fields).not.toContain('<span>B</span>')
    expect(fields.match(/type="number"/g)).toHaveLength(2)
    expect(fields).not.toContain('native-group')
    const curve = renderProperty(
      generatorTemplates.PiecewiseBezier!(),
      ['ps', 'startLife'],
      context,
    )
    expect(curve).toContain('class="native-generator"')
    expect(curve).toContain('Bezier curve preview')
    expect(curve).toContain('data-native-action="edit-curve"')
    expect(curve).not.toContain('type="number"')
    expect(curve).not.toContain('Curve segment')
  })

  it.each(['emissionOverTime', 'emissionOverDistance'])(
    'uses the compact scalar layout for %s',
    (key) => {
      const label = key === 'emissionOverTime' ? 'Emission Over Time' : 'Emission Over Distance'
      const fields = renderProperty(generatorTemplates.ConstantValue!(), ['ps', key], context)
      expect(fields).toContain(`<span class="native-generator-label">${label}</span>`)
      expect(fields).toContain('class="native-generator-mode"')
      expect(fields).toContain('class="native-generator-value constant"')
      expect(fields).not.toContain('native-group')
    },
  )

  it('uses the visual curve editor in nested generators and behaviors too', () => {
    for (const path of [
      ['ps', 'startSize', 'x'],
      ['ps', 'behaviors', 0, 'size'],
    ] as const) {
      const html = renderProperty(generatorTemplates.PiecewiseBezier!(), [...path], context)
      expect(html).toContain('data-native-action="edit-curve"')
      expect(html).not.toContain('data-native-kind="number"')
      expect(html).not.toContain('Curve segment')
    }
  })

  it('opens color and gradient generators through dedicated editors', () => {
    const color = renderProperty(generatorTemplates.ConstantColor!(), ['ps', 'startColor'], context)
    expect(color).toContain('data-native-action="edit-color"')
    expect(color).toContain('Start Color')
    expect(color).not.toContain('data-native-kind="number"')
    const gradient = renderProperty(generatorTemplates.Gradient!(), ['ps', 'startColor'], context)
    expect(gradient).toContain('data-native-action="edit-gradient"')
    expect(gradient).toContain('Start Color')
    expect(gradient).not.toContain('native-group')
    const randomGradient = renderProperty(
      generatorTemplates.RandomColorBetweenGradient!(),
      ['ps', 'startColor'],
      context,
    )
    expect(randomGradient.match(/data-native-action="edit-gradient"/g)).toHaveLength(2)
  })

  it('renders texture vectors as compact rows with readable axis and wrap labels', () => {
    const fields = renderProperties(
      {
        repeat: [1, 1],
        offset: [0, 0],
        center: [0, 0],
        wrap: [1001, 1001],
      },
      ['repeat', 'offset', 'center', 'wrap'],
      context,
      ['document', 'textures', 0],
    )
    expect(fields.match(/class="texture-vector-row"/g)).toHaveLength(4)
    expect(fields).toContain('<span>X</span>')
    expect(fields).toContain('<span>Y</span>')
    expect(fields).toContain('aria-label="Repeat X"')
    expect(fields).toContain('aria-label="Offset Y"')
    expect(fields).toContain('aria-label="Center X"')
    expect(fields).toContain('aria-label="Wrap U"')
    expect(fields).toContain('aria-label="Wrap V"')
    expect(fields).toContain('value="1001" selected>Clamp</option>')
    expect(fields).not.toMatch(/<span>[01]<\/span>/)
  })

  it('labels environment map Euler components and exposes rotation order choices', () => {
    const fields = renderProperties(
      { envMapRotation: [Math.PI / 2, 0, 0, 'XYZ'] },
      ['envMapRotation'],
      context,
      ['document', 'materials', 0],
    )
    for (const label of ['X (deg)', 'Y (deg)', 'Z (deg)', 'Order'])
      expect(fields).toContain(`<span>${label}</span>`)
    expect(fields).toContain('value="90"')
    expect(fields).toContain('data-native-kind="degrees"')
    expect(fields).toContain('<select data-native-path=')
    expect(fields).toContain('value="XYZ" selected')
    expect(fields).not.toMatch(/<span>[0-3]<\/span>/)
  })

  it('uses all burst parameters and permits multiple bursts', () => {
    const node = { ps: { emissionBursts: [] } }
    appendNativeItem(node, ['ps', 'emissionBursts'])
    appendNativeItem(node, ['ps', 'emissionBursts'])
    expect(node.ps.emissionBursts).toHaveLength(2)
    expect(node.ps.emissionBursts[0]).toMatchObject({ cycle: 1, interval: 0.1, probability: 1 })
  })

  it('splits cubic segments without changing the curve and interpolates gradient keys', () => {
    const curve = generatorTemplates.PiecewiseBezier!()
    const before = PiecewiseBezier.fromJSON(curve as FunctionJSON)
    appendNativeItem(curve, ['functions'])
    const after = PiecewiseBezier.fromJSON(curve as FunctionJSON)
    for (let index = 0; index <= 20; index++)
      expect(after.genValue([], index / 20)).toBeCloseTo(before.genValue([], index / 20), 10)
    validateNative(curve)
    const gradient = generatorTemplates.Gradient!()
    appendNativeItem(gradient, ['color', 'keys'])
    expect((gradient.color as NativeRecord).keys).toHaveLength(3)
    validateNative(gradient)
  })

  it('preserves disabled behavior values and original order across native JSON round trips', () => {
    const system = makeSystem()
    const group = new Group()
    group.add(system.emitter)
    const json = parseQuarksDocument(group.toJSON())
    const node = nativeNode(json, 0)
    const slots = ['Noise', 'ForceOverLife', 'SizeBySpeed'].map((type) => ({
      enabled: true,
      value: newBehavior(type, system),
    }))
    slots[1]!.enabled = false
    slots[0]!.enabled = false
    writeBehaviorSlots(node, slots)
    const loaded = new QuarksLoader().parse(json)
    const restored = nativeNode(parseQuarksDocument(loaded.toJSON()), 0)
    expect(behaviorSlots(restored)).toEqual(slots)
    const enabled = behaviorSlots(restored).map((slot) => ({ ...slot, enabled: true }))
    writeBehaviorSlots(restored, enabled)
    expect((restored.ps as NativeRecord).behaviors).toEqual(slots.map((slot) => slot.value))
    system.dispose()
  })

  it('does not silently drop runtime-only or unknown behaviors', () => {
    const system = makeSystem(),
      group = new Group()
    group.add(system.emitter)
    const json = parseQuarksDocument(group.toJSON())
    ;(nativeNode(json, 0).ps as NativeRecord).behaviors = [{ type: 'ApplyCollision', bounce: 1 }]
    expect(() => prepareNativeDocument(json)).toThrow('cannot load behavior ApplyCollision')
    system.dispose()
  })

  it('normalizes the upstream mesh/geometry field mismatch without patching Quarks', () => {
    const geometry = new BoxGeometry()
    const system = makeSystem(),
      group = new Group()
    system.emitterShape = new MeshSurfaceEmitter(geometry)
    group.add(system.emitter)
    const json = parseQuarksDocument(group.toJSON())
    json.geometries = [geometry.toJSON()]
    prepareNativeDocument(json)
    expect(((nativeNode(json, 0).ps as NativeRecord).shape as NativeRecord).geometry).toBe(
      geometry.uuid,
    )
    const loaded = new QuarksLoader().parse(json)
    expect(
      (
        (loaded.children[0] as unknown as { system: ParticleSystem }).system
          .emitterShape as MeshSurfaceEmitter
      ).geometry?.uuid,
    ).toBe(geometry.uuid)
    geometry.dispose()
    system.dispose()
  })
})

describe('native property validation', () => {
  it('preserves unused material and geometry assets without accumulating stale image copies', () => {
    const system = makeSystem(),
      group = new Group()
    group.add(system.emitter)
    const previous = parseQuarksDocument(group.toJSON())
    previous.materials = [
      { uuid: 'used', map: 'texture' },
      { uuid: 'unused', map: 'unused-texture' },
    ]
    previous.textures = [
      { uuid: 'texture', image: 'old-image' },
      { uuid: 'unused-texture', image: 'unused-image' },
    ]
    previous.images = [
      { uuid: 'old-image', url: 'a.png' },
      { uuid: 'unused-image', url: 'b.png' },
    ]
    const next = structuredClone(previous)
    next.materials = [{ uuid: 'used', map: 'texture', opacity: 0.5 }]
    next.textures = [{ uuid: 'texture', image: 'new-image' }]
    next.images = [{ uuid: 'new-image', url: 'a.png' }]
    preserveNativeAssets(previous, next)
    expect(next.materials).toHaveLength(2)
    expect(next.images?.map((image) => image.uuid)).toEqual(['unused-image', 'new-image'])
    expect((next.materials as NativeRecord[]).find((item) => item.uuid === 'used')?.opacity).toBe(
      0.5,
    )
    system.dispose()
  })
  it('includes the particle lifetime after non-looping emission ends', () => {
    const system = makeSystem()
    system.looping = false
    system.duration = 2
    const life = generatorTemplates.ConstantValue!()
    life.value = 3
    system.startLife = GeneratorFromJSON(life as FunctionJSON) as typeof system.startLife
    expect(particlePreviewDuration([system])).toBe(5)
    system.looping = true
    expect(particlePreviewDuration([system])).toBe(2)
    system.dispose()
  })
  it('uses a trail-safe Noise default and rejects Quarks-incompatible rotation settings', () => {
    const system = makeSystem(),
      group = new Group()
    group.add(system.emitter)
    const json = parseQuarksDocument(group.toJSON())
    const ps = nativeNode(json, 0).ps as NativeRecord
    const noise = newBehavior('Noise', system)
    ps.renderMode = 3
    ps.behaviors = [noise]
    expect(() => prepareNativeDocument(json)).not.toThrow()
    noise.rotationAmount = { type: 'ConstantValue', value: 1 }
    expect(() => prepareNativeDocument(json)).toThrow('trails have no rotation')
    system.dispose()
  })
  it('updates only existing own properties and rejects prototype pollution', () => {
    const node = { ps: { duration: 5 } }
    setNativeValue(node, ['ps', 'duration'], 2)
    expect(getNativeValue(node, ['ps', 'duration'])).toBe(2)
    expect(() => setNativeValue(node, ['ps', 'missing'], 1)).toThrow('Invalid property')
    expect(() => setNativeValue(node, ['__proto__', 'polluted'], true)).toThrow('Invalid property')
    expect(() => setNativeValue(node, [], {})).toThrow('document root')
  })
  it.each([
    { duration: NaN },
    { duration: 0 },
    { uTileCount: 1.5 },
    { probability: 2 },
    { type: 'IntervalValue', a: 2, b: 1 },
    { keys: [] },
    { functions: [{ start: 0 }, { start: 0 }] },
  ])('rejects unsafe numeric or curve edits %j', (value) => {
    expect(() => validateNative(value)).toThrow()
  })
  it('escapes labels, values, and resource names in the inspector', () => {
    const fields = renderProperty('<img onerror=alert(1)>', ['ps', 'name'], context)
    expect(fields).not.toContain('<img')
    expect(fields).toContain('&lt;img')
  })
})

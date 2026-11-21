import { describe, expect, it, vi } from 'vitest'
import {
  AdditiveBlending,
  CustomBlending,
  NoColorSpace,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ReverseSubtractEquation,
  Scene,
  Vector3,
} from 'three'
import {
  BatchedRenderer,
  PiecewiseBezier,
  QuarksLoader,
  RenderMode,
  type ParticleSystem,
} from 'three.quarks'
import { readUnityPackage } from '../src/unity-package'
import { prepareNativeDocument } from '../src/native-properties'
import type { QuarksDocument } from '../src/document'
import {
  materialGuid,
  packageEntries,
  packageFile,
  prefab,
  prefabGuid,
} from './fixtures/unity-package'

vi.mock('../src/local-files', () => ({
  readTextureFile: vi.fn(
    async () =>
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  ),
}))

const load = async (text = prefab, entries = packageEntries(text)) => {
  const unity = await readUnityPackage(packageFile({ ...entries, [`${prefabGuid}/asset`]: text }))
  return unity.convertPrefab(unity.prefabs[0]!)
}
const firePS = (json: QuarksDocument) => (json.object as any).children[0].children[1].ps
const curve = (json: unknown) => PiecewiseBezier.fromJSON(json as any)

const burstBlock = `    - time: 0.5
      countCurve: {minMaxState: 3, scalar: 8, minScalar: 4}
      cycleCount: 2
      repeatInterval: 0.3
      probability: 0.8`
const frameCurve =
  /frameOverTime:\n      minMaxState: 1\n      scalar: 0\.999\n      maxCurve:\n        m_Curve:\n        - \{time: 0, value: 0, outSlope: 1\}\n        - \{time: 1, value: 1, inSlope: 1\}/
const noContinuousEmission = (text: string) =>
  text
    .replace(
      'rateOverTime: {minMaxState: 0, scalar: 20}',
      'rateOverTime: {minMaxState: 0, scalar: 0}',
    )
    .replace(
      'rateOverDistance: {minMaxState: 0, scalar: 2}',
      'rateOverDistance: {minMaxState: 0, scalar: 0}',
    )

/** Plays a converted document with stock Quarks and returns the "Fire" system. */
function simulate(
  json: QuarksDocument,
  seconds: number,
  inspect: (system: ParticleSystem) => void,
) {
  prepareNativeDocument(json)
  // Image decoding needs a DOM; emission and motion do not depend on textures.
  const data = JSON.parse(JSON.stringify(json))
  delete data.images
  delete data.textures
  for (const material of data.materials ?? []) delete material.map
  const root = new QuarksLoader().parse(data)
  new Scene().add(root)
  const renderer = new BatchedRenderer()
  const systems: ParticleSystem[] = []
  root.traverse((node) => {
    if ('system' in node) systems.push(node.system as ParticleSystem)
  })
  for (const system of systems) renderer.addSystem(system)
  root.updateMatrixWorld(true)
  try {
    for (let time = 0; time < seconds - 1e-9; time += 1 / 60) renderer.update(1 / 60)
    inspect(systems.find((system) => system.emitter.name === 'Fire')!)
  } finally {
    for (const system of systems) system.dispose()
    renderer.dispose()
  }
}

const material = (
  body: string,
  shader = '{fileID: 211, guid: 0000000000000000f000000000000000, type: 0}',
) =>
  `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!21 &2100000
Material:
  m_Name: Test material
  m_Shader: ${shader}
${body}`
const loadMaterial = async (text: string, extra: Record<string, string> = {}) => {
  const entries = { ...packageEntries(), [`${materialGuid}/asset`]: text, ...extra }
  const { json, warnings } = await load(prefab, entries)
  const ps = firePS(json)
  return { material: (json.materials as any[]).find((m) => m.uuid === ps.material), warnings }
}

describe('Unity bursts', () => {
  it('fires every Unity burst cycle at runtime and sorts out-of-order bursts', async () => {
    const text = noContinuousEmission(prefab.replace('looping: 1', 'looping: 0')).replace(
      burstBlock,
      `    - time: 0.6
      countCurve: {minMaxState: 0, scalar: 2}
      cycleCount: 1
      repeatInterval: 1
      probability: 1
    - time: 0.1
      countCurve: {minMaxState: 0, scalar: 5}
      cycleCount: 3
      repeatInterval: 0.2
      probability: 1`,
    )
    const { json } = await load(text)
    const times = firePS(json).emissionBursts.map((burst: any) => burst.time)
    expect(times).toHaveLength(4)
    expect(times).toEqual([...times].sort((a: number, b: number) => a - b))
    // 3 cycles x 5 at 0.1, 0.3, 0.5 and 2 at 0.6; Quarks alone would emit 5 + 0 (unsorted).
    simulate(json, 1, (system) => expect(system.particleNum).toBe(17))
  })

  it('repeats an infinite Unity burst (cycleCount 0) until the end of the duration', async () => {
    const text = prefab.replace(
      burstBlock,
      `    - time: 0
      countCurve: {minMaxState: 0, scalar: 1}
      cycleCount: 0
      repeatInterval: 1
      probability: 1`,
    )
    const { json } = await load(text)
    // Looping: time 4 is the next cycle's time 0, so it must not fire twice.
    expect(firePS(json).emissionBursts.map((burst: any) => burst.time)).toEqual([0, 1, 2, 3])
    const once = await load(text.replace('looping: 1', 'looping: 0'))
    expect(firePS(once.json).emissionBursts.map((burst: any) => burst.time)).toEqual([
      0, 1, 2, 3, 4,
    ])
  })
})

describe('Unity start delay', () => {
  it('delays all emission of a non-looping system by extending its timeline', async () => {
    const text = prefab
      .replace('looping: 1', 'looping: 0')
      .replace('lengthInSec: 4', 'lengthInSec: 1\n  startDelay: {minMaxState: 0, scalar: 0.5}')
    const { json, warnings } = await load(text)
    const ps = firePS(json)
    expect(ps.duration).toBe(1.5)
    expect(ps.emissionBursts.map((burst: any) => burst.time)).toEqual([1, 1.3])
    expect(curve(ps.emissionOverTime).genValue([], 0.2)).toBe(0)
    expect(curve(ps.emissionOverTime).genValue([], 0.9)).toBe(20)
    expect(warnings.join('\n')).not.toContain('Start delay')
    simulate(json, 0.45, (system) => expect(system.particleNum).toBe(0))
    simulate(json, 0.8, (system) => expect(system.particleNum).toBeGreaterThan(0))
  })

  it('keeps the delayed phase of a looping burst that wraps past the duration', async () => {
    const text = noContinuousEmission(prefab)
      .replace('lengthInSec: 4', 'lengthInSec: 1\n  startDelay: {minMaxState: 0, scalar: 0.3}')
      .replace(burstBlock, burstBlock.replace('time: 0.5', 'time: 0.9'))
    const { json, warnings } = await load(text)
    expect(firePS(json).emissionBursts.map((burst: any) => burst.time)[0]).toBeCloseTo(0.2)
    expect(warnings.join('\n')).toContain('first looping cycle begins immediately')
  })
})

describe('Unity texture sheet animation', () => {
  it('picks a random tile per particle for random-between-constants Frame over Time', async () => {
    const text = prefab
      .replace(
        'startFrame: {minMaxState: 0, scalar: 0.25}',
        'startFrame: {minMaxState: 0, scalar: 0}',
      )
      .replace(frameCurve, 'frameOverTime: {minMaxState: 3, minScalar: 0, scalar: 0.9999}')
    const { json, warnings } = await load(text)
    const ps = firePS(json)
    expect(ps.startTileIndex.type).toBe('IntervalValue')
    expect(ps.startTileIndex.a).toBe(0)
    expect(ps.startTileIndex.b).toBeCloseTo(7.9992)
    expect(ps.behaviors.some((b: any) => b.type === 'FrameOverLife')).toBe(false)
    expect(warnings.join('\n')).not.toContain('maximum value')
    simulate(json, 2, (system) => {
      const tiles = new Set(
        system.particles.slice(0, system.particleNum).map((p) => Math.floor(p.uvTile)),
      )
      expect(tiles.size).toBeGreaterThan(3)
    })
  })

  it('repeats the frame curve for Unity cycles and FPS timing', async () => {
    const cycled = await load(prefab.replace('tilesX: 4', 'tilesX: 4\n    cycles: 2'))
    const frame = curve(
      firePS(cycled.json).behaviors.find((b: any) => b.type === 'FrameOverLife').frame,
    )
    // startFrame 0.25 of 8 tiles = 2; one cycle spans half of the lifetime.
    expect(frame.genValue([], 0)).toBeCloseTo(2)
    expect(frame.genValue([], 0.25)).toBeCloseTo(2 + 3.996)
    expect(frame.genValue([], 0.75)).toBeCloseTo(2 + 3.996)
    expect(frame.genValue([], 0.49)).toBeGreaterThan(9)

    const fps = await load(
      prefab
        .replace(
          'startLifetime: {minMaxState: 3, scalar: 3, minScalar: 2}',
          'startLifetime: {scalar: 4}',
        )
        .replace('tilesX: 4', 'tilesX: 4\n    timeMode: 2\n    fps: 4'),
    )
    const fpsFrame = curve(
      fps.json && firePS(fps.json).behaviors.find((b: any) => b.type === 'FrameOverLife').frame,
    )
    // 4 s x 4 fps over 8 tiles = 2 cycles.
    expect(fpsFrame.genValue([], 0.25)).toBeCloseTo(fpsFrame.genValue([], 0.75))
  })

  it('offsets single-row animation to the selected row', async () => {
    const { json } = await load(
      prefab.replace(
        'tilesX: 4',
        'tilesX: 4\n    animationType: 1\n    rowMode: 0\n    rowIndex: 1',
      ),
    )
    const ps = firePS(json)
    // Row 1 starts at tile 4; startFrame 0.25 of a 4-frame row is 1.
    expect(ps.startTileIndex.value).toBeCloseTo(5)
    const frame = curve(ps.behaviors.find((b: any) => b.type === 'FrameOverLife').frame)
    expect(frame.genValue([], 1)).toBeCloseTo(5 + 3.996)
  })
})

describe('Unity materials', () => {
  it('uses the tint property of the built-in particle shader, not a stale legacy one', async () => {
    const { material: m } = await loadMaterial(
      material(`  m_ShaderKeywords: _ALPHABLEND_ON
  m_SavedProperties:
    m_Floats:
    - _SrcBlend: 5
    - _DstBlend: 10
    m_Colors:
    - _Color: {r: 1, g: 1, b: 1, a: 1}
    - _TintColor: {r: 0.5, g: 0.5, b: 0.5, a: 0.5}`),
    )
    expect(m.color).toBe(0xffffff)
    expect(m.opacity ?? 1).toBe(1)
  })

  it('reports ambiguous tints of an unavailable shader, including integer YAML channels', async () => {
    const { material: m, warnings } = await loadMaterial(
      material(
        `  m_SavedProperties:
    m_Colors:
    - _TintColor: {r: 1, g: 0, b: 0, a: 1}
    - _Color: {r: 0, g: 1, b: 0, a: 1}`,
        '{fileID: 4800000, guid: 88888888888888888888888888888888, type: 3}',
      ),
    )
    expect(m.color).toBe(0xff0000)
    expect(warnings.join('\n')).toContain('tint uses _TintColor among differing')
  })

  it('leaves a material untinted and opaque when its shader declares no tint or blending', async () => {
    const shaderGuid = '66666666666666666666666666666666'
    const { material: m } = await loadMaterial(
      material(
        `  m_SavedProperties:
    m_Colors:
    - _TintColor: {r: 0.5, g: 0.5, b: 0.5, a: 0.5}`,
        `{fileID: 4800000, guid: ${shaderGuid}, type: 3}`,
      ),
      {
        [`${shaderGuid}/pathname`]: 'Assets/Shaders/Icon.shader',
        [`${shaderGuid}/asset`]: `Shader "Test/Icon" {
  Properties {
    _Icon ("Icon", 2D) = "white" {}
  }
  SubShader {
    CGPROGRAM
    #pragma surface surf Unlit keepalpha
    ENDCG
  }
}`,
      },
    )
    expect(m.color).toBe(0xffffff)
    expect(m.opacity ?? 1).toBe(1)
    expect(m.transparent ?? false).toBe(false)
  })

  it.each([
    [
      'premultiplied',
      '    - _SrcBlend: 1\n    - _DstBlend: 10',
      { blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor },
    ],
    [
      'subtractive',
      '    - _SrcBlend: 5\n    - _DstBlend: 1\n    - _BlendOp: 2',
      { blending: CustomBlending, blendEquation: ReverseSubtractEquation },
    ],
  ])('maps %s Unity blend factors exactly', async (_, floats, expected) => {
    const { material: m } = await loadMaterial(
      material(
        `  m_SavedProperties:\n    m_Floats:\n${floats}\n    m_Colors:\n    - _Color: {r: 1, g: 1, b: 1, a: 1}`,
      ),
    )
    expect(m).toMatchObject(expected)
  })

  it('renders opaque and cutout Standard-family materials without alpha blending', async () => {
    const { material: m } = await loadMaterial(
      material(`  m_ShaderKeywords: _ALPHATEST_ON
  m_SavedProperties:
    m_Floats:
    - _SrcBlend: 1
    - _DstBlend: 0
    - _Cutoff: 0.3`),
    )
    expect(m.transparent ?? false).toBe(false)
    expect(m.alphaTest).toBe(0.3)
  })

  it('reads a fixed-function Blend directive when the material has no blend floats', async () => {
    const shaderGuid = '77777777777777777777777777777777'
    const { material: m } = await loadMaterial(
      material('  m_SavedProperties: {}', `{fileID: 4800000, guid: ${shaderGuid}, type: 3}`),
      {
        [`${shaderGuid}/pathname`]: 'Assets/Shaders/Glow.shader',
        [`${shaderGuid}/asset`]:
          'Shader "Test/Glow" {\n  SubShader { Pass {\n    Blend SrcAlpha One\n  } }\n}',
      },
    )
    expect(m.blending).toBe(AdditiveBlending)
  })

  it('samples textures without sRGB decoding, matching the unencoded Quarks unlit output', async () => {
    const { json } = await load()
    expect((json.textures as any[])[0].colorSpace).toBe(NoColorSpace)
  })

  it('generates the built-in Default-Particle sprite and still warns for other built-in materials', async () => {
    const builtin = (fileID: number) =>
      prefab.replace(
        `- {fileID: 2100000, guid: ${materialGuid}, type: 2}`,
        `- {fileID: ${fileID}, guid: 0000000000000000f000000000000000, type: 0}`,
      )
    const { json, warnings } = await load(builtin(10301))
    const ps = firePS(json)
    const m = (json.materials as any[]).find((item) => item.uuid === ps.material)
    expect(m.name).toBe('Default-Particle')
    const url = String((json.images as any[])[0].url)
    expect(url.startsWith('data:image/png;base64,')).toBe(true)
    const png = Buffer.from(url.split(',')[1]!, 'base64')
    expect([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG')
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([64, 64])
    expect(warnings.join('\n')).toContain('Default-Particle')
    const other = await load(builtin(10302))
    expect(other.warnings.join('\n')).toContain('is not in the package')
  })
})

describe('Unity shapes', () => {
  it('emits Unity rectangles across their area along the shape forward axis', async () => {
    const text = prefab
      .replace('type: 4\n    angle: 30', 'type: 18\n    m_Scale: {x: 2, y: 4, z: 1}\n    angle: 30')
      .replace(
        'rateOverTime: {minMaxState: 0, scalar: 20}',
        'rateOverTime: {minMaxState: 0, scalar: 6000}',
      )
    const { json } = await load(text)
    expect(firePS(json).shape).toMatchObject({ type: 'grid', width: 2, height: 4 })
    simulate(json, 1 / 60, (system) => {
      const particles = system.particles.slice(0, system.particleNum)
      expect(particles.length).toBeGreaterThan(50)
      let interior = 0
      for (const p of particles) {
        // GameObject (1, 2, 3) in Unity is (1, 2, -3); Unity +Z is three.js -Z.
        const v = new Vector3(p.velocity.x, p.velocity.y, p.velocity.z).normalize()
        expect(v.z).toBeCloseTo(-1, 6)
        expect(Math.abs(p.position.x - 1)).toBeLessThanOrEqual(1 + 1e-6)
        expect(Math.abs(p.position.y - 2)).toBeLessThanOrEqual(2 + 1e-6)
        if (Math.abs(p.position.x - 1) < 0.9 && Math.abs(p.position.y - 2) < 1.9) interior++
      }
      expect(interior).toBeGreaterThan(particles.length / 2)
    })
  })

  it('sizes boxes from the modern shape scale and reports the dropped depth', async () => {
    const { json, warnings } = await load(
      prefab.replace(
        'type: 4\n    angle: 30',
        'type: 5\n    m_Scale: {x: 3, y: 1, z: 0.5}\n    angle: 30',
      ),
    )
    expect(firePS(json).shape).toMatchObject({ type: 'grid', width: 3, height: 1 })
    expect(warnings.join('\n')).toContain('box volume depth')
  })

  it('applies shape position and rotation to spawn positions and directions', async () => {
    const text = prefab
      .replace(
        'angle: 30',
        'angle: 0\n    m_Position: {x: 1, y: 0, z: 0}\n    m_Rotation: {x: 90, y: 0, z: 0}',
      )
      .replace('radius: {value: 0.25}', 'radius: {value: 0.0001}')
    const { json, warnings } = await load(text)
    expect(warnings.join('\n')).not.toContain('m_Position')
    simulate(json, 1 / 60, (system) => {
      expect(system.particleNum).toBeGreaterThan(0)
      for (const p of system.particles.slice(0, system.particleNum)) {
        // Unity Euler(90, 0, 0) turns the cone's +Z into world down.
        const v = new Vector3(p.velocity.x, p.velocity.y, p.velocity.z).normalize()
        expect(v.y).toBeCloseTo(-1, 6)
        expect(p.position.x).toBeCloseTo(2, 3)
        expect(Math.abs(p.position.y - 2)).toBeLessThan(0.1)
        expect(p.position.z).toBeCloseTo(-3, 3)
      }
    })
  })

  it('bakes uniform shape scale into the native radius', async () => {
    const { json } = await load(
      prefab.replace(
        'type: 4\n    angle: 30',
        'type: 0\n    m_Scale: {x: 2, y: 2, z: 2}\n    angle: 30',
      ),
    )
    expect(firePS(json).shape).toMatchObject({ type: 'sphere', radius: 0.5 })
  })
})

describe('Unity forces', () => {
  const rotated = (x: number, w: number) =>
    prefab.replace(
      'm_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
      `m_LocalRotation: {x: ${x}, y: 0, z: 0, w: ${w}}`,
    )
  const forceModule = (z: string, world = 0) =>
    `ForceModule:\n    enabled: 1\n    z: ${z}\n    inWorldSpace: ${world}\n  NoiseModule: {enabled: 0}`

  it('rotates a local-space force by the static hierarchy into the world acceleration Quarks applies', async () => {
    // Unity Euler(90, 0, 0): local +Z points down.
    const text = rotated(0.7071068, 0.7071068)
      .replace('NoiseModule: {enabled: 0}', forceModule('{scalar: 10}'))
      .replace('startSpeed: {minMaxState: 0, scalar: 4}', 'startSpeed: {minMaxState: 0, scalar: 0}')
    const { json } = await load(text)
    const force = firePS(json).behaviors.find(
      (b: any) => b.type === 'ForceOverLife' && b.z.value === 0 && b.y.value !== 0,
    )
    expect(force.x.value).toBeCloseTo(0)
    expect(force.y.value).toBeCloseTo(-10)
    simulate(json, 0.5, (system) => {
      const p = system.particles[0]!
      expect(p.velocity.y).toBeLessThan(-4)
      expect(Math.abs(p.velocity.x) + Math.abs(p.velocity.z)).toBeLessThan(1e-6)
    })
  })

  it('permutes random local forces under axis-aligned rotations and reports other rotations', async () => {
    const random = '{minMaxState: 3, minScalar: 1, scalar: 2}'
    const aligned = await load(
      rotated(0.7071068, 0.7071068).replace('NoiseModule: {enabled: 0}', forceModule(random)),
    )
    const force = firePS(aligned.json).behaviors.find((b: any) => b.type === 'ForceOverLife')
    expect(force.y).toEqual({ type: 'IntervalValue', a: -2, b: -1 })

    const oblique = await load(
      rotated(0.3826834, 0.9238795).replace('NoiseModule: {enabled: 0}', forceModule(random)),
    )
    expect(oblique.warnings.join('\n')).toContain('cannot be represented')
    expect(oblique.warnings.join('\n')).toContain('ForceModule is enabled but not converted')
  })

  it('converts a world-space force in a local-space simulation', async () => {
    const { json, warnings } = await load(
      prefab
        .replace('moveWithTransform: 1', 'moveWithTransform: 0')
        .replace('NoiseModule: {enabled: 0}', forceModule('{scalar: 3}', 1)),
    )
    expect(
      firePS(json).behaviors.some((b: any) => b.type === 'ForceOverLife' && b.z.value === -3),
    ).toBe(true)
    expect(warnings.join('\n')).not.toContain('ForceModule is enabled but not converted')
  })
})

describe('Unity curves and built-in resources', () => {
  it('converts two flat curves exactly and approximates shaped ones', async () => {
    const twoCurves = (max: string) =>
      prefab.replace(
        'curve: {minMaxState: 0, scalar: 0.2}',
        `curve:\n      minMaxState: 2\n      scalar: 1\n      minCurve:\n        m_Curve:\n        - {time: 0, value: -1}\n        - {time: 1, value: -1}\n      maxCurve:\n        m_Curve:\n${max}`,
      )
    const flat = await load(
      twoCurves('        - {time: 0, value: 3}\n        - {time: 1, value: 3}'),
    )
    const rotation = firePS(flat.json).behaviors.find((b: any) => b.type === 'RotationOverLife')
    expect(rotation.angularVelocity).toEqual({ type: 'IntervalValue', a: -3, b: 1 })
    const shaped = await load(
      twoCurves('        - {time: 0, value: 0}\n        - {time: 1, value: 3}'),
    )
    expect(shaped.warnings.join('\n')).toContain('random between two curves')
  })

  it('evaluates curves whose keys extend outside [0, 1] instead of rejecting the prefab', async () => {
    const { json } = await load(
      prefab.replace(
        '        - {time: 0, value: 0, inSlope: 0, outSlope: 1}\n        - {time: 1, value: 1, inSlope: 1, outSlope: 0}',
        '        - {time: -0.5, value: 0, inSlope: 1, outSlope: 1}\n        - {time: 1.5, value: 2, inSlope: 1, outSlope: 1}',
      ),
    )
    const size = curve(firePS(json).behaviors.find((b: any) => b.type === 'SizeOverLife').size)
    // Linear 0 -> 2 over [-0.5, 1.5], times the size scalar 2.
    expect(size.genValue([], 0)).toBeCloseTo(1)
    expect(size.genValue([], 1)).toBeCloseTo(3)
  })

  it.each([
    [10207, 'Sphere'],
    [10206, 'Cylinder'],
  ])('renders the built-in %s mesh (fileID %#) as mesh particles', async (fileID) => {
    const { json, warnings } = await load(
      prefab.replace(
        'm_RenderMode: 0',
        `m_RenderMode: 4\n  m_Mesh: {fileID: ${fileID}, guid: 0000000000000000e000000000000000, type: 0}`,
      ),
    )
    expect(firePS(json).renderMode).toBe(RenderMode.Mesh)
    expect(warnings.join('\n')).not.toContain('Using a billboard instead')
  })

  it('skips empty sub-emitter slots and reports prefab-wide limits once', async () => {
    const { warnings } = await load(
      prefab.replace(
        'NoiseModule: {enabled: 0}',
        'SubModule:\n    enabled: 1\n    subEmitters:\n    - emitter: {fileID: 0}\n      type: 0\n  NoiseModule: {enabled: 0}',
      ),
    )
    expect(warnings.join('\n')).not.toContain('Sub emitter 0')
    expect(warnings.filter((warning) => warning.includes('maxParticles'))).toHaveLength(1)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { AdditiveBlending, CustomBlending, Matrix4, OneFactor, Quaternion, Vector3 } from 'three'
import {
  EmitSubParticleSystem,
  Gradient,
  RenderMode,
  SubParticleEmitMode,
  TrailParticle,
  Vector3 as QVector3,
  Vector4 as QVector4,
} from 'three.quarks'
import { ColorOverTrail, RandomColorFromGradient, loadUnityPlugin } from '../src/unity-behaviors'
import { decodePsd, readUnityPackage } from '../src/unity-package'
import type { QuarksDocument } from '../src/document'
import {
  materialGuid,
  packageEntries,
  packageFile,
  particleShader,
  prefab,
  prefabGuid,
  textureGuid,
} from './fixtures/unity-package'

vi.mock('../src/local-files', () => ({
  readTextureFile: vi.fn(
    async () =>
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  ),
}))

const ROOT_GO = '9007199254740992'
const ROOT_TRANSFORM = '9007199254740993'
const FIRE_PS = '9007199254740994'
const FIRE_RENDERER = '9007199254740995'
const CHILD_GO = '9007199254740996'
const CHILD_PS = '9007199254740998'

const convert = async (entries: Record<string, string | Uint8Array>, path?: string) => {
  const unity = await readUnityPackage(packageFile(entries))
  return unity.convertPrefab(path ?? unity.prefabs[0]!)
}
const scaleOf = (node: any) => {
  const scale = new Vector3()
  new Matrix4().fromArray(node.matrix).decompose(new Vector3(), new Quaternion(), scale)
  return scale.toArray().map((value) => +value.toFixed(6))
}
const nodes = (json: QuarksDocument) => {
  const result: any[] = []
  const walk = (node: any, parentVisible: boolean) => {
    const visible = parentVisible && node.visible !== false
    result.push({ ...node, effectiveVisible: visible })
    for (const child of node.children ?? []) walk(child, visible)
  }
  walk(json.object, true)
  return result
}
const emitter = (json: QuarksDocument, name: string) =>
  nodes(json).find((node) => node.ps && node.name === name)

const uiParticle = (gameObject: string, body: string) => `
--- !u!114 &9007199254741999
MonoBehaviour:
  m_GameObject: {fileID: ${gameObject}}
  m_Script: {fileID: 11500000, guid: 99999999999999999999999999999999, type: 3}
${body}`

/** The fixture as a UI effect: RectTransform with a driven (zeroed) scale, disabled renderer. */
const uiPrefab = (component: string, rootScale = '{x: 0, y: 0, z: 0}') =>
  prefab
    .replace(
      '--- !u!4 &9007199254740993\nTransform:',
      '--- !u!224 &9007199254740993\nRectTransform:',
    )
    .replace('m_LocalScale: {x: 1, y: 1, z: 1}', `m_LocalScale: ${rootScale}`)
    .replace('m_Enabled: 1\n  m_RenderMode: 0', 'm_Enabled: 0\n  m_RenderMode: 0') + component

describe('UIParticle prefabs', () => {
  it('shows canvas-rendered systems and restores the scale driven by Transform auto scaling', async () => {
    const { json, warnings } = await convert(
      packageEntries(
        uiPrefab(
          uiParticle(
            ROOT_GO,
            `  m_Enabled: 1
  m_Scale3D: {x: 50, y: 50, z: 50}
  m_Particles:
  - {fileID: ${FIRE_PS}}
  m_AutoScalingMode: 2`,
          ),
        ),
      ),
    )
    const root = (json.object as any).children[0]
    expect(scaleOf(root)).toEqual([1, 1, 1])
    expect(emitter(json, 'Fire').effectiveVisible).toBe(true)
    expect(warnings.join('\n')).toContain('UIParticle renders 1 Particle System(s)')
    expect(warnings.join('\n')).not.toContain('scripts, animation')
    expect((json.object as any).userData.unityImport.uiParticles).toEqual([
      expect.objectContaining({ scale: [50, 50, 50], autoScalingMode: 2 }),
    ])
  })

  it('compensates a scaled parent like Unity sets lossyScale to one', async () => {
    const text = prefab
      .replace('m_LocalScale: {x: 1, y: 1, z: 1}', 'm_LocalScale: {x: 2, y: 4, z: 2}')
      .replace('m_Name: Inactive child\n  m_IsActive: 0', 'm_Name: UI child\n  m_IsActive: 1')
      .replace(
        'm_LocalPosition: {x: 0, y: 1, z: 2}',
        'm_LocalPosition: {x: 0, y: 1, z: 2}\n  m_LocalScale: {x: 0, y: 0, z: 0}',
      )
    const { json } = await convert(
      packageEntries(
        text +
          uiParticle(
            CHILD_GO,
            `  m_Scale3D: {x: 10, y: 10, z: 10}
  m_Particles:
  - {fileID: ${CHILD_PS}}
  m_AutoScalingMode: 2`,
          ),
      ),
    )
    const child = nodes(json).find((node) => node.name === 'UI child' && !node.ps)
    expect(scaleOf(child)).toEqual([0.5, 0.25, 0.5])
  })

  it('keeps disabled renderers hidden without an enabled UIParticle listing their system', async () => {
    const disabled = await convert(
      packageEntries(
        uiPrefab(
          uiParticle(
            ROOT_GO,
            `  m_Enabled: 0
  m_Scale3D: {x: 50, y: 50, z: 50}
  m_Particles:
  - {fileID: ${FIRE_PS}}
  m_AutoScalingMode: 2`,
          ),
          '{x: 3, y: 3, z: 3}',
        ),
      ),
    )
    expect(emitter(disabled.json, 'Fire').effectiveVisible).toBe(false)
    expect(scaleOf((disabled.json.object as any).children[0])).toEqual([3, 3, 3])

    // UIParticle-mode scaling leaves the serialized transform scale; unlisted systems stay hidden.
    const unlisted = await convert(
      packageEntries(
        uiPrefab(
          uiParticle(
            ROOT_GO,
            `  m_Scale3D: {x: 50, y: 50, z: 50}
  m_Particles:
  - {fileID: ${CHILD_PS}}
  m_AutoScalingMode: 1`,
          ),
          '{x: 2, y: 2, z: 2}',
        ),
      ),
    )
    expect(emitter(unlisted.json, 'Fire').effectiveVisible).toBe(false)
    expect(scaleOf((unlisted.json.object as any).children[0])).toEqual([2, 2, 2])
  })
})

const VARIANT_GUID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const HOST_GUID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const BLUE_MATERIAL_GUID = 'cccccccccccccccccccccccccccccccc'
const instanceId = (instance: string, source: string) =>
  String((BigInt(instance) ^ BigInt(source)) & ((1n << 63n) - 1n))
const override = (target: string, path: string, value: string, reference = '{fileID: 0}') =>
  `    - target: {fileID: ${target}, guid: ${prefabGuid}, type: 3}
      propertyPath: ${path}
      value: ${value}
      objectReference: ${reference}`

describe('UIParticle depth and subtrees', () => {
  const CHILD_TRANSFORM = '9007199254740997'
  const canvas = uiPrefab(
    uiParticle(
      ROOT_GO,
      `  m_Enabled: 1
  m_Scale3D: {x: 50, y: 50, z: 50}
  m_Particles:
  - {fileID: ${FIRE_PS}}
  m_AutoScalingMode: 2`,
    ),
  )
  const positions = (json: QuarksDocument) =>
    Object.fromEntries(
      nodes(json)
        .filter((node) => !node.ps && node.matrix)
        .map((node) => [node.name, (node.matrix as number[]).slice(12, 15)]),
    )

  it('drops Z offsets of a UIParticle effect, which a UI canvas ignores', async () => {
    const { json } = await convert(packageEntries(canvas))
    expect(positions(json)).toMatchObject({ Fire: [1, 2, 0], 'Inactive child': [0, 1, 0] })
  })

  it('keeps Z offsets of a world-space effect', async () => {
    const { json } = await convert(packageEntries())
    expect(positions(json)).toMatchObject({ Fire: [1, 2, -3], 'Inactive child': [0, 1, -2] })
  })

  it('converts only the requested subtree and leaves its placement to the caller', async () => {
    const unity = await readUnityPackage(packageFile(packageEntries()))
    const { json, particleCount } = await unity.convertPrefab(unity.prefabs[0]!, {
      root: CHILD_TRANSFORM,
    })
    expect(particleCount).toBe(1)
    expect(emitter(json, 'Fire')).toBeUndefined()
    // Inactive in the prefab, but the subtree root's visibility belongs to the caller.
    expect(emitter(json, 'Inactive child').effectiveVisible).toBe(true)
    expect(positions(json)['Inactive child']).toEqual([0, 0, 0])
    await expect(unity.convertPrefab(unity.prefabs[0]!, { root: '1' })).rejects.toThrow(
      'Transform 1 is not in the prefab.',
    )
  })
})

describe('Unity prefab variants and nested prefabs', () => {
  it('merges a variant with overrides, removed components and added objects', async () => {
    const instance = '1234567'
    const strippedRoot = instanceId(instance, ROOT_TRANSFORM)
    const variant = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1001 &${instance}
PrefabInstance:
  m_Modification:
    m_TransformParent: {fileID: 0}
    m_Modifications:
${override(ROOT_GO, 'm_Name', 'Blue fire')}
${override(FIRE_PS, 'InitialModule.startSpeed.scalar', '9')}
${override(FIRE_PS, 'EmissionModule.m_Bursts.Array.size', '0')}
${override(FIRE_PS, 'SizeModule.curve.maxCurve.m_Curve.Array.data[1].value', '3')}
${override(FIRE_RENDERER, "'m_Materials.Array.data[0]'", '', `{fileID: 2100000, guid: ${BLUE_MATERIAL_GUID}, type: 2}`)}
    m_RemovedComponents:
    - {fileID: ${CHILD_PS}, guid: ${prefabGuid}, type: 3}
  m_SourcePrefab: {fileID: 100100000, guid: ${prefabGuid}, type: 3}
--- !u!4 &${strippedRoot} stripped
Transform:
  m_CorrespondingSourceObject: {fileID: ${ROOT_TRANSFORM}, guid: ${prefabGuid}, type: 3}
  m_PrefabInstance: {fileID: ${instance}}
--- !u!1 &500
GameObject:
  m_Name: Sparks
  m_IsActive: 1
--- !u!4 &501
Transform:
  m_GameObject: {fileID: 500}
  m_Father: {fileID: ${strippedRoot}}
--- !u!198 &502
ParticleSystem:
  m_GameObject: {fileID: 500}
  InitialModule:
    startLifetime: {scalar: 1}
`
    const { json, particleCount } = await convert(
      {
        ...packageEntries(),
        [`${VARIANT_GUID}/pathname`]: 'Assets/Effects/Blue fire.prefab',
        [`${VARIANT_GUID}/asset`]: variant,
        [`${BLUE_MATERIAL_GUID}/pathname`]: 'Assets/Materials/Blue.mat',
        [`${BLUE_MATERIAL_GUID}/asset`]: packageEntries()[`${materialGuid}/asset`]!.replace(
          'Fire material',
          'Blue material',
        ),
      },
      'Assets/Effects/Blue fire.prefab',
    )
    expect(particleCount).toBe(2)
    const fire = emitter(json, 'Blue fire')
    expect(fire.ps.startSpeed.value).toBe(9)
    expect(fire.ps.emissionBursts).toEqual([])
    const size = fire.ps.behaviors.find((b: any) => b.type === 'SizeOverLife').size
    expect(size.functions.at(-1).function.p3).toBeCloseTo(6)
    const material = (json.materials as any[]).find((m) => m.uuid === fire.ps.material)
    expect(material.name).toBe('Blue material')
    const sparks = nodes(json).find((node) => node.name === 'Sparks' && !node.ps)
    const blue = (json.object as any).children[0]
    expect(blue.children.map((child: any) => child.uuid)).toContain(sparks.uuid)
  })

  it('parents a nested prefab instance under its transform parent', async () => {
    const host = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &10
GameObject:
  m_Name: Host
  m_IsActive: 1
--- !u!4 &11
Transform:
  m_GameObject: {fileID: 10}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Father: {fileID: 0}
--- !u!1001 &77
PrefabInstance:
  m_Modification:
    m_TransformParent: {fileID: 11}
    m_Modifications:
${override(ROOT_TRANSFORM, 'm_LocalPosition.x', '5')}
  m_SourcePrefab: {fileID: 100100000, guid: ${prefabGuid}, type: 3}
`
    const { json, particleCount } = await convert(
      {
        ...packageEntries(),
        [`${HOST_GUID}/pathname`]: 'Assets/Effects/Host.prefab',
        [`${HOST_GUID}/asset`]: host,
      },
      'Assets/Effects/Host.prefab',
    )
    expect(particleCount).toBe(2)
    const hostNode = (json.object as any).children[0]
    const fire = hostNode.children.find((child: any) => child.name === 'Fire')
    expect(fire.matrix[12]).toBe(5)
  })

  it('reads multi-line override values whose closing quote Unity writes at column one', async () => {
    const host = (value: string) => `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &10
GameObject:
  m_Name: Host
  m_IsActive: 1
--- !u!4 &11
Transform:
  m_GameObject: {fileID: 10}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Father: {fileID: 0}
--- !u!1001 &77
PrefabInstance:
  m_Modification:
    m_TransformParent: {fileID: 11}
    m_Modifications:
${override(ROOT_GO, 'm_Name', value)}
  m_SourcePrefab: {fileID: 100100000, guid: ${prefabGuid}, type: 3}
`
    const name = async (value: string) => {
      const { json } = await convert(
        {
          ...packageEntries(),
          [`${HOST_GUID}/pathname`]: 'Assets/Effects/Host.prefab',
          [`${HOST_GUID}/asset`]: host(value),
        },
        'Assets/Effects/Host.prefab',
      )
      return (json.object as any).children[0].children[0].name
    }
    expect(await name("'Spark\n\n\n'")).toBe('Spark\n\n')
    expect(await name("'Ember\n\n'")).toBe('Ember\n')
  })

  it('rejects cyclic prefab instances', async () => {
    const cyclic = (source: string) => `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1001 &1
PrefabInstance:
  m_Modification: {m_TransformParent: {fileID: 0}, m_Modifications: []}
  m_SourcePrefab: {fileID: 100100000, guid: ${source}, type: 3}
`
    await expect(
      convert(
        {
          [`${VARIANT_GUID}/pathname`]: 'Assets/A.prefab',
          [`${VARIANT_GUID}/asset`]: cyclic(HOST_GUID),
          [`${HOST_GUID}/pathname`]: 'Assets/B.prefab',
          [`${HOST_GUID}/asset`]: cyclic(VARIANT_GUID),
        },
        'Assets/A.prefab',
      ),
    ).rejects.toThrow(/cyclic/i)
  })
})

/** Builds a minimal 8-bit PSD with the given merged image data section. */
function psd(width: number, height: number, channels: number, mode: number, image: number[]) {
  const header = [
    ...[0x38, 0x42, 0x50, 0x53],
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    channels,
    ...[0, 0, 0, height],
    ...[0, 0, 0, width],
    0,
    8,
    0,
    mode,
  ]
  return new Uint8Array([
    ...header,
    ...[0, 0, 0, 0],
    ...[0, 0, 0, 4, 1, 2, 3, 4],
    ...[0, 0, 0, 0],
    ...image,
  ])
}

describe('Photoshop textures', () => {
  it('decodes raw RGBA composite data', () => {
    // Two pixels, planar channels: R, G, B, A.
    const file = psd(2, 1, 4, 3, [0, 0, 10, 20, 30, 40, 50, 60, 255, 128])
    expect([...decodePsd(file).rgba]).toEqual([10, 30, 50, 255, 20, 40, 60, 128])
  })

  it('decodes PackBits grayscale data and un-mattes when requested', () => {
    // Rows: gray = repeat 200 ×2; alpha = literal [255, 128].
    const file = psd(2, 1, 2, 1, [0, 1, 0, 2, 0, 3, 0xff, 200, 1, 255, 128])
    expect([...decodePsd(file).rgba]).toEqual([200, 200, 200, 255, 200, 200, 200, 128])
    const unmatted = decodePsd(file, true).rgba
    expect(unmatted[4]).toBe(Math.round(((200 - 127) * 255) / 128))
  })

  it('rejects unsupported or malformed files', () => {
    expect(() => decodePsd(new Uint8Array([1, 2, 3]))).toThrow(/PSD/)
    const sixteenBit = psd(1, 1, 3, 3, [0, 0, 1, 2, 3])
    sixteenBit[23] = 16
    expect(() => decodePsd(sixteenBit)).toThrow(/16-bit/)
    expect(() => decodePsd(psd(2, 1, 1, 1, [0, 1, 0, 3, 0x7f, 1, 2]))).toThrow(/RLE/)
  })

  it('imports a PSD texture as an embedded PNG', async () => {
    const entries = packageEntries()
    const { json, warnings } = await convert({
      ...entries,
      [`${textureGuid}/pathname`]: 'Assets/Textures/Fire.psd',
      [`${textureGuid}/asset`]: psd(2, 1, 4, 3, [0, 0, 10, 20, 30, 40, 50, 60, 255, 128]),
    })
    expect(String((json.images as any[])[0].url)).toMatch(/^data:image\/png;base64,/)
    expect(warnings.join('\n')).toContain('Fire.psd: Photoshop texture is converted')
  })
})

describe('Unity color modes and trails', () => {
  const fixedColor = (mode: number) =>
    prefab.replace(
      '        m_NumColorKeys: 2\n        m_NumAlphaKeys: 2\n        key0: {r: 1, g: 0, b: 0, a: 1}\n        key1: {r: 0, g: 1, b: 0, a: 0}\n        ctime0: 0',
      `        m_Mode: ${mode}\n        m_NumColorKeys: 2\n        m_NumAlphaKeys: 2\n        key0: {r: 1, g: 0, b: 0, a: 1}\n        key1: {r: 0, g: 1, b: 0, a: 0}\n        ctime0: 32768`,
    )
  const colorAt = (json: QuarksDocument, t: number) => {
    const behavior = emitter(json, 'Fire').ps.behaviors.find((b: any) => b.type === 'ColorOverLife')
    const color = Gradient.fromJSON(behavior.color).genColor([], new QVector4(), t)
    return [color.x, color.y, color.z].map((value) => +value.toFixed(3))
  }

  it('samples a random gradient point per particle for Random Color start colors', async () => {
    const { json, warnings } = await convert(
      packageEntries(
        prefab.replace(
          '      minMaxState: 2\n      minColor: {r: 1, g: 0, b: 0, a: 1}\n      maxColor: {r: 1, g: 0.5, b: 0, a: 0.5}',
          `      minMaxState: 4
      maxGradient:
        m_NumColorKeys: 2
        m_NumAlphaKeys: 2
        key0: {r: 1, g: 0, b: 0, a: 1}
        key1: {r: 0, g: 0, b: 1, a: 1}
        ctime0: 0
        ctime1: 65535
        atime0: 0
        atime1: 65535`,
        ),
      ),
    )
    const ps = emitter(json, 'Fire').ps
    expect(ps.startColor).toMatchObject({ type: 'ConstantColor' })
    expect(ps.behaviors[0].type).toBe('RandomColorFromGradient')
    expect(warnings.join('\n')).not.toContain('random-color')
    const particle = { memory: [], startColor: new QVector4(), color: new QVector4() } as any
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.25)
    RandomColorFromGradient.fromJSON(ps.behaviors[0]).initialize(particle)
    expect(particle.color.toArray().map((value: number) => +value.toFixed(3))).toEqual([
      0.75, 0, 0.25, 1,
    ])
  })

  it('holds each key of a Fixed gradient up to its time, and blends otherwise', async () => {
    const fixed = (await convert(packageEntries(fixedColor(1)))).json
    expect(colorAt(fixed, 0.25)).toEqual([1, 0, 0])
    expect(colorAt(fixed, 0.75)).toEqual([0, 1, 0])
    const blend = (await convert(packageEntries(fixedColor(0)))).json
    expect(colorAt(blend, 0.75)).toEqual([0.5, 0.5, 0])
  })

  const trail = (extra = '') =>
    `  TrailModule:
    enabled: 1
    mode: 0
    lifetime: {minMaxState: 0, scalar: 0.5}
    widthOverTrail: {minMaxState: 0, scalar: 2}
    sizeAffectsWidth: 0
    inheritParticleColor: 1
${extra}  RotationModule:`
  const trailed = (text: string, extra?: string) => text.replace('  RotationModule:', trail(extra))

  it('draws Particles-mode trails with their own width and lifetime', async () => {
    const { json, warnings } = await convert(packageEntries(trailed(prefab)))
    const ps = emitter(json, 'Fire').ps
    expect(ps.renderMode).toBe(RenderMode.Trail)
    // Trail lifetime 0.5 of the 3 s maximum particle lifetime, one point per 1/60 s.
    expect(ps.rendererEmitterSettings.startLength).toMatchObject({ value: 90 })
    expect(ps.startSize).toMatchObject({ type: 'ConstantValue', value: 2 })
    expect(ps.behaviors.map((b: any) => b.type)).not.toContain('SizeOverLife')
    expect(warnings.join('\n')).not.toContain('TrailModule is enabled but not converted')
  })

  it('colors trail points along the trail with Color over Trail', async () => {
    const { json } = await convert(
      packageEntries(
        trailed(
          prefab,
          `    colorOverTrail:
      minMaxState: 1
      maxGradient:
        m_NumColorKeys: 2
        m_NumAlphaKeys: 2
        key0: {r: 1, g: 1, b: 1, a: 0}
        key1: {r: 1, g: 1, b: 1, a: 1}
        ctime0: 0
        ctime1: 65535
        atime0: 0
        atime1: 65535
`,
        ),
      ),
    )
    const behavior = emitter(json, 'Fire').ps.behaviors.find(
      (b: any) => b.type === 'ColorOverTrail',
    )
    const trail = ColorOverTrail.fromJSON(behavior)
    // Four recorded points of a 4-point trail, oldest first; t runs from 0 at the particle to 1.
    const particle = new TrailParticle()
    particle.length = 4
    for (let i = 0; i < 4; i++)
      particle.previous.push({ position: new QVector3(), size: 1, color: new QVector4(1, 1, 1, 1) })
    // Applied twice: the point's recorded color stays the base.
    trail.update(particle)
    trail.update(particle)
    expect([...particle.previous.values()].map((point: any) => point.color.w)).toEqual([
      1, 0.75, 0.5, 0.25,
    ])
  })

  it('scales absolute trail widths by the canvas of UIParticle-scaled systems', async () => {
    const ui = trailed(
      uiPrefab(
        uiParticle(
          ROOT_GO,
          `  m_Enabled: 1
  m_Scale3D: {x: 50, y: 50, z: 50}
  m_Particles:
  - {fileID: ${FIRE_PS}}
  m_AutoScalingMode: 1`,
        ),
      ),
    )
    const unity = await readUnityPackage(packageFile(packageEntries(ui)))
    const scaled = await unity.convertPrefab(unity.prefabs[0]!, { canvasWorldScale: 0.25 })
    expect(emitter(scaled.json, 'Fire').ps.startSize).toMatchObject({ value: 0.5 })
    const unknown = await unity.convertPrefab(unity.prefabs[0]!)
    expect(emitter(unknown.json, 'Fire').ps.startSize).toMatchObject({ value: 2 })
    expect(unknown.warnings.join('\n')).toContain('UI canvas world scale, which is not given')
    // A width carried by the particle size is scaled the same way.
    const sizedPackage = await readUnityPackage(
      packageFile(packageEntries(ui.replace('    sizeAffectsWidth: 0', '    sizeAffectsWidth: 1'))),
    )
    const sized = await sizedPackage.convertPrefab(sizedPackage.prefabs[0]!, {
      canvasWorldScale: 0.25,
    })
    // Start size 0.5 times trail width 2 times canvas scale 0.25.
    expect(emitter(sized.json, 'Fire').ps.startSize).toMatchObject({ value: 0.25 })
    // A system in Local scaling mode keeps the canvas-scaled trail width.
    const localPackage = await readUnityPackage(
      packageFile(packageEntries(ui.replace('  InitialModule:', '  scalingMode: 1\n  InitialModule:'))),
    )
    const local = await localPackage.convertPrefab(localPackage.prefabs[0]!, {
      canvasWorldScale: 0.25,
    })
    expect(emitter(local.json, 'Fire').ps.startSize).toMatchObject({ value: 0.5 })
  })

  it('scales the project gravity by the canvas only for UIParticle-scaled systems', async () => {
    const gravityY = async (mode: number, scalingMode?: number) => {
      const text = uiPrefab(
        uiParticle(
          ROOT_GO,
          `  m_Enabled: 1
  m_Scale3D: {x: 50, y: 50, z: 50}
  m_Particles:
  - {fileID: ${FIRE_PS}}
  m_AutoScalingMode: ${mode}`,
        ),
      ).replace(
        '  InitialModule:\n    enabled: 1\n',
        `${scalingMode === undefined ? '' : `  scalingMode: ${scalingMode}\n`}  InitialModule:\n    enabled: 1\n    gravityModifier: {minMaxState: 0, scalar: 1}\n`,
      )
      const unity = await readUnityPackage(packageFile(packageEntries(text)))
      const { json, warnings } = await unity.convertPrefab(unity.prefabs[0]!, {
        canvasWorldScale: 0.25,
        gravity: -20,
      })
      expect(warnings.join('\n')).not.toContain('using Unity default gravity')
      const force = emitter(json, 'Fire').ps.behaviors.find((b: any) => b.type === 'ForceOverLife')
      return force.y.value
    }
    expect(await gravityY(1)).toBe(-5)
    expect(await gravityY(2)).toBe(-20)
    // Hierarchy scaling keeps the canvas factor; Local scaling is compensated by UIParticle, so
    // gravity keeps its size relative to the particles.
    expect(await gravityY(1, 0)).toBe(-5)
    expect(await gravityY(1, 1)).toBe(-20)
    expect(await gravityY(2, 1)).toBe(-20)
  })
})

describe('Unity sub-emitter semantics', () => {
  it('emits Death sub-emissions where the particle died, not following its reused object', () => {
    loadUnityPlugin()
    const target = { system: { duration: 1 } } as any
    const particle = {
      age: 0.9,
      life: 1,
      position: new QVector3(1, 2, 3),
      velocity: new QVector3(),
    } as any
    const owner = { worldSpace: true, emitter: { matrixWorld: new Matrix4() } } as any
    const death = new EmitSubParticleSystem(owner, false, target, SubParticleEmitMode.Death)
    death.update(particle, 0.2)
    expect((death as any).subEmissions[0].particle).toBeUndefined()
    // Birth emissions still follow their particle, as in Unity.
    const birth = new EmitSubParticleSystem(owner, false, target, SubParticleEmitMode.Birth)
    birth.update({ ...particle, age: 0 }, 0.2)
    expect((birth as any).subEmissions[0].particle).toBeDefined()
  })
})

describe('Unity shader blending', () => {
  const blended = async (shader: string) => {
    const { json } = await convert({
      ...packageEntries(),
      '44444444444444444444444444444444/asset': shader,
    })
    const ps = emitter(json, 'Fire').ps
    return (json.materials as any[]).find((m) => m.uuid === ps.material)
  }
  // A custom shader name: built-in particle shader names map to fixed blending.
  const additive = particleShader
    .replace('Shader "Particles/Additive"', 'Shader "UI/Glow"')
    .replace('Blend [_SrcBlend] [_DstBlend]', 'Blend One One')
    // Declared blend properties make the material's saved floats authoritative.
    .replace(/^.*_(Src|Dst)Blend \(.*\n/gm, '')

  it('treats Blend One One with an alpha-premultiplied fragment as additive alpha blending', async () => {
    const shader = additive.replace(
      'ZWrite Off',
      'ZWrite Off\n      // color.rgb *= color.a;\n      CGPROGRAM color.rgb *= color.a; ENDCG',
    )
    expect(await blended(shader)).toMatchObject({ blending: AdditiveBlending })
  })

  it('keeps Blend One One as plain addition when the fragment does not premultiply', async () => {
    expect(await blended(additive)).toMatchObject({
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneFactor,
    })
  })
})

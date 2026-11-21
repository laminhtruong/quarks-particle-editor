import { describe, expect, it, vi } from 'vitest'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { decodePsd, readUnityPackage } from '../src/unity-package'
import type { QuarksDocument } from '../src/document'
import {
  materialGuid,
  packageEntries,
  packageFile,
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

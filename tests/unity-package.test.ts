import { gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { AdditiveBlending, ClampToEdgeWrapping, NearestFilter, RepeatWrapping, Scene } from 'three'
import { BatchedRenderer, ParticleSystem, QuarksLoader } from 'three.quarks'
import { readUnityPackage } from '../src/unity-package'
import { prepareNativeDocument, validateNative } from '../src/native-properties'
import { readTextureFile } from '../src/local-files'
import {
  materialGuid,
  packageEntries,
  packageFile,
  prefab,
  prefabGuid,
  tar,
  textureGuid,
} from './fixtures/unity-package'

const imageUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
vi.mock('../src/local-files', () => ({ readTextureFile: vi.fn(async () => imageUrl) }))

const load = async (text = prefab, entries = packageEntries(text)) => {
  const unity = await readUnityPackage(packageFile(entries))
  return unity.convertPrefab(unity.prefabs[0]!)
}

describe('Unity package import', () => {
  it.each([
    ['star.png', 'image/png'],
    ['star.JPG', 'image/jpeg'],
    ['star.jpeg', 'image/jpeg'],
    ['star.webp', 'image/webp'],
    ['star.gif', 'image/gif'],
  ])('sets the browser MIME type when reconstructing %s from archive bytes', async (name, type) => {
    const entries = packageEntries()
    entries[`${textureGuid}/pathname`] = `Assets/Textures/${name}`
    await load(prefab, entries)
    expect(readTextureFile).toHaveBeenLastCalledWith(expect.objectContaining({ name, type }))
  })

  it('still rejects a texture when image decoding fails', async () => {
    vi.mocked(readTextureFile).mockRejectedValueOnce(new Error('Could not decode Fire.png'))
    await expect(load()).rejects.toThrow('Could not decode Fire.png')
  })

  it('lists all prefab paths, leaving conversion to the selected prefab', async () => {
    const entries = packageEntries()
    entries['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pathname'] = 'Assets/Other.prefab'
    entries['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/asset'] = 'binary prefab'
    const unity = await readUnityPackage(packageFile(entries))
    expect(unity.prefabs).toEqual(['Assets/Effects/Fire.prefab', 'Assets/Other.prefab'])
    await expect(unity.convertPrefab('unknown')).rejects.toThrow('Choose a prefab')
    await expect(unity.convertPrefab('Assets/Other.prefab')).rejects.toThrow('Force Text')
    await expect(unity.convertPrefab(unity.prefabs[0]!)).resolves.toHaveProperty('particleCount', 2)
  })

  it('preserves 64-bit IDs, hierarchy, inactive objects, common modules and embedded GUID-resolved assets', async () => {
    const { json, warnings, particleCount } = await load()
    expect(particleCount).toBe(2)
    const root = json.object as any
    const gameObject = root.children[0]
    expect(gameObject.name).toBe('Fire')
    expect(gameObject.matrix.slice(12, 15)).toEqual([1, 2, -3])
    expect(gameObject.userData.unityFileID).toBe('9007199254740992')
    expect(gameObject.children[0].name).toBe('Inactive child')
    expect(gameObject.children[0].visible).toBe(false)
    expect(gameObject.children[0].matrix.slice(12, 15)).toEqual([0, 1, -2])
    const emitter = gameObject.children[1]
    expect(emitter.type).toBe('ParticleEmitter')
    const ps = emitter.ps
    expect(ps.startLife).toEqual({ type: 'IntervalValue', a: 2, b: 3 })
    expect(ps.startRotation).toEqual({ type: 'ConstantValue', value: -0.3 })
    expect(ps.startColor.type).toBe('ColorRange')
    expect(ps.shape).toMatchObject({ type: 'cone', radius: 0.25, arc: Math.PI })
    expect(ps.shape.angle).toBeCloseTo(Math.PI / 6)
    expect(ps.emissionOverTime.value).toBe(20)
    expect(ps.emissionBursts[0]).toMatchObject({
      time: 0.5,
      cycle: 2,
      interval: 0.3,
      probability: 0.8,
      count: { type: 'IntervalValue', a: 4, b: 8 },
    })
    expect(ps.behaviors.map((b: any) => b.type)).toEqual([
      'ColorOverLife',
      'SizeOverLife',
      'RotationOverLife',
      'FrameOverLife',
    ])
    const size = ps.behaviors[1].size.functions[0].function
    expect(size).toMatchObject({ p0: 0, p1: 2 / 3, p3: 2 })
    expect(size.p2).toBeCloseTo(4 / 3)
    expect(ps.startTileIndex.value).toBe(2)
    expect([ps.uTileCount, ps.vTileCount]).toEqual([4, 2])
    const material = (json.materials as any[]).find((m) => m.uuid === ps.material)
    expect(material).toMatchObject({
      name: 'Fire material',
      blending: AdditiveBlending,
      opacity: 0.8,
      depthWrite: false,
    })
    expect((json.textures as any[])[0]).toMatchObject({
      repeat: [2, 3],
      offset: [0.1, 0.2],
      wrap: [RepeatWrapping, ClampToEdgeWrapping],
      magFilter: NearestFilter,
    })
    expect(json.images).toHaveLength(1)
    expect(json.images![0]!.url).toBe(imageUrl)
    expect(readTextureFile).toHaveBeenCalled()
    expect(warnings.join('\n')).toContain('NoiseModule')
    expect(warnings.join('\n')).toContain('Particles/Additive')
    expect(root.userData.unityImport.warnings).toEqual(warnings)
    expect(JSON.stringify(json)).not.toContain('9007199254740993n')
    expect(() => {
      prepareNativeDocument(json)
      validateNative(json)
    }).not.toThrow()
  })

  it('loads and simulates the converted document with stock Quarks', async () => {
    const entries = packageEntries()
    delete entries[`${materialGuid}/asset`]
    const { json } = await load(prefab, entries)
    prepareNativeDocument(json)
    validateNative(json)
    const root = new QuarksLoader().parse(json)
    new Scene().add(root)
    const renderer = new BatchedRenderer()
    const systems: ParticleSystem[] = []
    root.traverse((node) => {
      if ('system' in node) systems.push(node.system as ParticleSystem)
    })
    for (const system of systems) renderer.addSystem(system)
    root.updateMatrixWorld(true)
    for (let i = 0; i < 60; i++) renderer.update(1 / 60)
    expect(systems).toHaveLength(2)
    expect(systems.some((system) => system.particleNum > 0)).toBe(true)
    for (const system of systems) system.dispose()
    renderer.dispose()
  })

  it('warns about missing and unsupported textures instead of fetching or dropping the prefab', async () => {
    const entries = packageEntries()
    delete entries[`${textureGuid}/asset`]
    let result = await load(prefab, entries)
    expect(result.warnings.join('\n')).toContain(`texture ${textureGuid} is missing`)
    entries[`${textureGuid}/asset`] = 'tga'
    entries[`${textureGuid}/pathname`] = 'Assets/Textures/Fire.tga'
    result = await load(prefab, entries)
    expect(result.warnings.join('\n')).toContain('convert it to PNG')
    expect(result.json.images).toEqual([])
  })

  it('converts scalar lifetime modules to evaluable curves, warning on approximations', async () => {
    const text = prefab
      .replace(
        'minMaxState: 1\n      scalar: 2',
        'minMaxState: 3\n      minScalar: 1\n      scalar: 2',
      )
      .replace(
        'NoiseModule: {enabled: 1}',
        'NoiseModule: {enabled: 1}\n  startDelay: {minMaxState: 0, scalar: 2}',
      )
    const result = await load(text)
    expect(result.warnings.join('\n')).toContain('random constants')
    expect(result.warnings.join('\n')).toContain('Start delay')
    const emitter = (result.json.object as any).children[0].children[1]
    expect(emitter.ps.behaviors[1].size.type).toBe('PiecewiseBezier')
  })

  it.each([
    [
      prefab + '\n--- !u!1001 &42\nPrefabInstance:\n  m_SourcePrefab: {fileID: 1}\n',
      'nested prefabs/variants',
    ],
    [prefab.replace('m_Father: {fileID: 0}', 'm_Father: {fileID: 9007199254740997}'), 'Cyclic'],
    [prefab.replace('m_Father: {fileID: 0}', 'm_Father: {fileID: 42}'), 'missing parent'],
    [prefab.replace('m_Name: Fire', 'm_Name: Fire\n  m_Name: duplicate'), 'Invalid Unity YAML'],
    [prefab.replace('m_Name: Fire', 'm_Name: &a [*a]'), 'alias'],
    ['not a serialized prefab', 'Force Text'],
  ])(
    'rejects unsupported or invalid prefab data without producing partial JSON',
    async (text, error) => {
      await expect(load(text)).rejects.toThrow(new RegExp(error, 'i'))
    },
  )

  it('rejects non-packages, invalid gzip, empty packages, and excessive compressed size', async () => {
    await expect(readUnityPackage(new File(['x'], 'x.zip'))).rejects.toThrow('.unitypackage')
    await expect(readUnityPackage(new File(['x'], 'x.unitypackage'))).rejects.toThrow('decompress')
    await expect(
      readUnityPackage({ name: 'x.unitypackage', size: 129 * 1024 * 1024 } as File),
    ).rejects.toThrow('128 MB')
    await expect(readUnityPackage(packageFile({}))).rejects.toThrow('no .prefab')
  })

  it('rejects unsafe or ambiguous archive entries and malformed tar', async () => {
    const entries = packageEntries()
    entries[`${prefabGuid}/pathname`] = '../Fire.prefab'
    await expect(readUnityPackage(packageFile(entries))).rejects.toThrow('Unsafe')
    entries[`${prefabGuid}/pathname`] = 'Assets/Fire.prefab'
    entries['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pathname'] = 'Assets/Fire.prefab'
    entries['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/asset'] = prefab
    await expect(readUnityPackage(packageFile(entries))).rejects.toThrow(
      'Duplicate Unity asset path',
    )
    const broken = tar(packageEntries())
    broken[0] = 0
    await expect(
      readUnityPackage(new File([new Uint8Array(gzipSync(broken))], 'bad.unitypackage')),
    ).rejects.toThrow('checksum')
    await expect(
      readUnityPackage(
        new File(
          [new Uint8Array(gzipSync(tar(packageEntries()).subarray(0, 512)))],
          'bad.unitypackage',
        ),
      ),
    ).rejects.toThrow('truncated')
  })
})

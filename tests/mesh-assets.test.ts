import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BufferGeometryLoader,
  FileLoader,
  LoadingManager,
  Group,
  InstancedBufferGeometry,
  InstancedBufferAttribute,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  type BufferGeometryJSON,
} from 'three'
import {
  QuarksLoader,
  MeshSurfaceEmitter,
  EmitSubParticleSystem,
  type ParticleSystem,
} from 'three.quarks'
import { parseQuarksDocument } from '../src/document'
import { prepareFolderExport, writeFolderExport } from '../src/folder-export'
import { readMeshJson, resolveMeshAssets } from '../src/mesh-assets'
import { loadProjectEffect } from '../src/project-loader'
import { resolveFolderAssets } from '../src/local-files'
import { memoryFolder } from './fixtures/folder'
import { meshEffect } from './fixtures/mesh'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('external project mesh assets', () => {
  it('preserves instanced and interleaved geometry data without flattening buffers', async () => {
    const geometry = new InstancedBufferGeometry()
    geometry.instanceCount = 2
    const buffer = new InterleavedBuffer(
      new Float32Array([0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      5,
    )
    geometry.setAttribute('position', new InterleavedBufferAttribute(buffer, 3, 0))
    geometry.setAttribute('uv', new InterleavedBufferAttribute(buffer, 2, 3))
    geometry.setAttribute(
      'offset',
      new InstancedBufferAttribute(new Float32Array([0, 0, 0, 2, 0, 0]), 3),
    )
    geometry.setIndex([0, 1, 2])
    const json = meshEffect().json
    json.geometries = [geometry.toJSON()]
    const bundle = await prepareFolderExport(json, 'https://game.test/')
    await resolveMeshAssets(bundle.json, async (path) =>
      JSON.parse(await bundle.files.get(path)!.text()),
    )
    expect(bundle.json.geometries).toEqual(json.geometries)
    const restored = new BufferGeometryLoader().parse(
      (bundle.json.geometries as BufferGeometryJSON[])[0]!,
    )
    expect(restored).toBeInstanceOf(InstancedBufferGeometry)
    expect(restored.getAttribute('position')).toBeInstanceOf(InterleavedBufferAttribute)
    expect(restored.getAttribute('position').getX(1)).toBe(1)
    expect(restored.getAttribute('uv').getX(1)).toBe(1)
    expect(restored.getAttribute('offset')).toBeInstanceOf(InstancedBufferAttribute)
  })

  it.each([false, true])(
    'extracts native mesh arrays and restores renderer/emitter geometry (surface=%s)',
    async (surface) => {
      const source = meshEffect('triangle', surface)
      const before = structuredClone(source.json)
      const bundle = await prepareFolderExport(source.json, 'https://game.test/')
      expect(source.json).toEqual(before)
      const references = bundle.json.geometries as Record<string, unknown>[]
      expect(references.every((geometry) => geometry.data === undefined)).toBe(true)
      const path = [...bundle.files.keys()][0]!
      expect(path).toMatch(/^assets\/meshes\/[a-f0-9]{16}\.json$/)
      const payload = JSON.parse(await bundle.files.get(path)!.text())
      expect(payload.uuid).toBeUndefined()
      expect(payload.name).toBeUndefined()
      expect(payload.data.attributes.position.array).toEqual(
        Array.from(source.geometry.getAttribute('position').array),
      )
      const folder = memoryFolder()
      await writeFolderExport(folder.directory, 'triangle.json', bundle)
      await resolveFolderAssets(bundle.json, folder.directory)
      expect(bundle.json.geometries).toEqual(source.json.geometries)
      const group = new QuarksLoader().parse(bundle.json)
      const system = (group.children[0] as unknown as { system: ParticleSystem }).system
      const restored = surface
        ? (system.emitterShape as MeshSurfaceEmitter).geometry!
        : system.instancingGeometry
      expect(restored.uuid).toBe(source.geometry.uuid)
      expect(restored.name).toBe('triangle')
      for (const key of ['position', 'normal', 'uv', 'color', 'skinIndex', 'skinWeight']) {
        expect(restored.getAttribute(key).array).toEqual(source.geometry.getAttribute(key).array)
        expect(restored.getAttribute(key).normalized).toBe(
          source.geometry.getAttribute(key).normalized,
        )
      }
      expect(restored.index!.array).toEqual(source.geometry.index!.array)
      expect(restored.groups).toEqual(source.geometry.groups)
      expect(restored.morphAttributes.position![0]!.array).toEqual(
        source.geometry.morphAttributes.position![0]!.array,
      )
      expect(restored.morphTargetsRelative).toBe(true)
    },
  )

  it('shares files across different UUIDs/names and object-key order, but separates changed mesh data', async () => {
    const first = meshEffect('first')
    const second = meshEffect('second')
    const geometries = second.json.geometries as Record<string, unknown>[]
    geometries[0] = Object.fromEntries(Object.entries(geometries[0]!).reverse())
    const folder = memoryFolder()
    const a = await prepareFolderExport(first.json, 'https://game.test/')
    const b = await prepareFolderExport(second.json, 'https://game.test/')
    expect([...a.files.keys()]).toEqual([...b.files.keys()])
    await writeFolderExport(folder.directory, 'first.json', a)
    await writeFolderExport(folder.directory, 'second.json', b)
    expect(folder.files.size).toBe(3)
    const changed = new BufferGeometryLoader().parse(geometries[0] as unknown as BufferGeometryJSON)
    changed.getAttribute('position').setX(0, 42)
    second.json.geometries = [changed.toJSON()]
    const c = await prepareFolderExport(second.json, 'https://game.test/')
    expect([...c.files.keys()]).not.toEqual([...a.files.keys()])
  })

  it('loads each mesh once while retaining separate reference UUIDs, names, and editable data', async () => {
    const source = meshEffect()
    const bundle = await prepareFolderExport(source.json, 'https://game.test/')
    const reference = (bundle.json.geometries as Record<string, unknown>[])[0]!
    bundle.json.geometries = [reference, { ...reference, uuid: 'another', name: 'another' }]
    const read = vi.fn(async (path: string) => JSON.parse(await bundle.files.get(path)!.text()))
    await resolveMeshAssets(bundle.json, read)
    expect(read).toHaveBeenCalledOnce()
    const [a, b] = bundle.json.geometries as Record<string, unknown>[]
    expect(b).toMatchObject({ uuid: 'another', name: 'another' })
    expect(a!.data).toEqual(b!.data)
    expect(a!.data).not.toBe(b!.data)
  })

  it('loads external meshes in the game with the same manager and relative asset paths', async () => {
    const source = meshEffect('game')
    const bundle = await prepareFolderExport(source.json, 'https://game.test/')
    const path = [...bundle.files.keys()][0]!
    const load = vi.spyOn(FileLoader.prototype, 'loadAsync').mockImplementation(async function (
      this: FileLoader,
      url,
    ) {
      if (url === '/effects/game.json') return structuredClone(bundle.json)
      expect(this.path).toBe('/effects/')
      expect(url).toBe(path)
      expect(this.responseType).toBe('blob')
      return bundle.files.get(path)!
    })
    const manager = new LoadingManager()
    const link = vi.spyOn(QuarksLoader.prototype, 'linkReference')
    const group = await loadProjectEffect('/effects/game.json', manager)
    expect(load).toHaveBeenCalledTimes(2)
    expect(link).toHaveBeenCalledWith(group)
    const system = (group.children[0] as unknown as { system: ParticleSystem }).system
    expect(system.instancingGeometry.getAttribute('position').array).toEqual(
      source.geometry.getAttribute('position').array,
    )
    expect(load.mock.instances.every((loader) => (loader as FileLoader).manager === manager)).toBe(
      true,
    )
  })

  it('links sub-emitters after asynchronous game loading and still accepts legacy inline meshes', async () => {
    const source = meshEffect('parent')
    const target = meshEffect('child')
    source.system.behaviors.push(
      new EmitSubParticleSystem(source.system, false, target.system.emitter),
    )
    const group = new Group().add(source.system.emitter, target.system.emitter)
    const native = parseQuarksDocument(group.toJSON())
    const bundle = await prepareFolderExport(native, 'https://game.test/')
    const load = vi
      .spyOn(FileLoader.prototype, 'loadAsync')
      .mockImplementation(async (url) =>
        url === 'effect.json' ? structuredClone(bundle.json) : bundle.files.get(url)!,
      )
    const restored = await loadProjectEffect('effect.json')
    const system = (restored.children[0] as unknown as { system: ParticleSystem }).system
    expect((system.behaviors[0] as EmitSubParticleSystem).subParticleSystem).toBe(
      restored.children[1],
    )
    expect(load).toHaveBeenCalledTimes(2)
    load.mockResolvedValueOnce(native)
    const legacy = await loadProjectEffect('inline.json')
    expect(legacy.children).toHaveLength(2)
    expect(load).toHaveBeenCalledTimes(3)
    load.mockResolvedValueOnce(bundle.json).mockRejectedValueOnce(new Error('Mesh HTTP 404'))
    await expect(loadProjectEffect('missing.json')).rejects.toThrow('404')
  })

  it('keeps the previous JSON when a mesh asset conflicts or cannot be written', async () => {
    const bundle = await prepareFolderExport(meshEffect().json, 'https://game.test/')
    const path = [...bundle.files.keys()][0]!
    const folder = memoryFolder()
    folder.files.set('mesh.json', new Blob(['old']))
    folder.write.mockRejectedValueOnce(new Error('Disk full'))
    await expect(writeFolderExport(folder.directory, 'mesh.json', bundle)).rejects.toThrow(
      'Disk full',
    )
    expect(await folder.files.get('mesh.json')!.text()).toBe('old')
    folder.files.set(path, new Blob(['corrupt']))
    await expect(writeFolderExport(folder.directory, 'mesh.json', bundle)).rejects.toThrow(
      'conflicting contents',
    )
    expect(await folder.files.get('mesh.json')!.text()).toBe('old')
  })

  it.each([
    '../escape.json',
    '/absolute.json',
    'https://host/a.json',
    'data:text/plain,a',
    'a\\b.json',
    '%2e%2e/a.json',
    'a/%2e%2e/b.json',
    'a%5cb.json',
  ])('rejects unsafe mesh reference %s before reading', async (url) => {
    const json = meshEffect().json
    json.geometries = [{ uuid: 'mesh', type: 'BufferGeometry', url }]
    expect(() => parseQuarksDocument(json)).toThrow('Invalid external mesh reference')
    const read = vi.fn()
    await expect(resolveMeshAssets(json, read)).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects missing, malformed, nested, and wrong-type mesh files without changing references', async () => {
    const bundle = await prepareFolderExport(meshEffect().json, 'https://game.test/')
    const before = structuredClone(bundle.json)
    await expect(
      resolveMeshAssets(bundle.json, async () => {
        throw new Error('Missing mesh')
      }),
    ).rejects.toThrow('Missing mesh')
    for (const payload of [
      { type: 'BufferGeometry' },
      { type: 'BufferGeometry', data: { attributes: {} }, url: 'other.json' },
      { type: 'InstancedBufferGeometry', data: { attributes: {} } },
    ])
      await expect(resolveMeshAssets(bundle.json, async () => payload)).rejects.toThrow()
    expect(bundle.json).toEqual(before)
    await expect(readMeshJson(new Blob(['not JSON']))).rejects.toThrow()
    await expect(readMeshJson(new Blob([]))).rejects.toThrow('64 MB')
    const text = vi.fn()
    await expect(
      readMeshJson({ size: 64 * 1024 * 1024 + 1, text } as unknown as Blob),
    ).rejects.toThrow('64 MB')
    expect(text).not.toHaveBeenCalled()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  prepareFolderExport,
  textureAssetPath,
  writeFolderAssets,
  writeFolderExport,
} from '../src/folder-export'
import type { QuarksDocument } from '../src/document'
import { memoryFolder } from './fixtures/folder'
import {
  DataTexture,
  FileLoader,
  Group,
  ImageLoader,
  LoadingManager,
  MeshBasicMaterial,
} from 'three'
import { ParticleSystem, QuarksLoader } from 'three.quarks'

const documentWith = (urls: unknown[]): QuarksDocument => ({
  metadata: { version: 4.7, type: 'Object' },
  object: { type: 'Group', children: [{ type: 'ParticleEmitter' }] },
  images: urls.map((url, index) => ({ uuid: `image-${index}`, url })),
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('native folder export', () => {
  it('reports assets only after committing or validating them and awaits each update', async () => {
    const folder = memoryFolder()
    const files = new Map([
      ['assets/textures/first.png', new Blob(['first'])],
      ['assets/textures/second.png', new Blob(['second'])],
    ])
    const report = vi.fn(async (path: string) => {
      expect(folder.files.get(path)).toBe(files.get(path))
      await Promise.resolve()
    })
    await writeFolderAssets(folder.directory, files, report)
    await writeFolderAssets(folder.directory, files, report)
    expect(report.mock.calls.map(([path]) => path)).toEqual([...files.keys(), ...files.keys()])
    expect(folder.write).toHaveBeenCalledTimes(2)
    folder.write.mockRejectedValueOnce(new Error('Disk full'))
    await expect(
      writeFolderAssets(
        folder.directory,
        new Map([['assets/textures/third.png', new Blob(['third'])]]),
        report,
      ),
    ).rejects.toThrow('Disk full')
    expect(report).toHaveBeenCalledTimes(4)
  })

  it('loads the exported JSON and relative textures through the stock game loader', async () => {
    const group = new Group()
    const system = new ParticleSystem({
      material: new MeshBasicMaterial({
        map: new DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1),
      }),
    })
    group.add(system.emitter)
    const source = group.toJSON() as unknown as QuarksDocument
    source.images![0]!.url = 'data:image/png;base64,aGVsbG8='
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('hello', { headers: { 'Content-Type': 'image/png' } })),
    )
    const bundle = await prepareFolderExport(source, 'https://game.test/')
    vi.spyOn(FileLoader.prototype, 'load').mockImplementation((_url, onLoad) => {
      onLoad!(JSON.stringify(bundle.json))
    })
    const images = vi
      .spyOn(ImageLoader.prototype, 'load')
      .mockImplementation((url) => ({ src: url }) as HTMLImageElement)
    const loader = new QuarksLoader(new LoadingManager())
    const parse = vi.spyOn(loader, 'parse')
    loader.load('/game/effects/fire.json')
    const path = `/game/effects/${[...bundle.files.keys()][0]}`
    expect(images).toHaveBeenCalledWith(path, expect.any(Function), undefined, expect.any(Function))
    const loaded = parse.mock.results[0]!.value as Group
    expect(loaded.children[0]!.type).toBe('ParticleEmitter')
    expect(
      ((loaded.children[0] as typeof system.emitter).system as ParticleSystem).material,
    ).toMatchObject({ map: { image: { src: path } } })
  })
  it('extracts embedded images, shares identical content across UUIDs and URLs, and preserves the source', async () => {
    const data = 'data:image/png;base64,aGVsbG8='
    const source = documentWith([data, [data, 'textures/smoke.png']])
    const fetchImage = vi.fn(
      async (_url: URL) => new Response('hello', { headers: { 'Content-Type': 'image/png' } }),
    )
    vi.stubGlobal('fetch', fetchImage)
    const { json, files } = await prepareFolderExport(source, 'https://game.test/effects/')
    const path = [...files.keys()][0]!
    expect(path).toMatch(/^assets\/textures\/[a-f0-9]{16}\.png$/)
    expect(files.size).toBe(1)
    expect(json.images).toEqual([
      { uuid: 'image-0', url: path },
      { uuid: 'image-1', url: [path, path] },
    ])
    expect(source.images![0]!.url).toBe(data)
    expect(fetchImage).toHaveBeenCalledTimes(2)
    expect(String(fetchImage.mock.calls[1]![0])).toBe(
      'https://game.test/effects/textures/smoke.png',
    )
  })

  it('keeps distinct images separate and retains numeric texture precision', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: URL) =>
          new Response(url.pathname, {
            headers: {
              'Content-Type': url.pathname.endsWith('.jpg') ? 'image/jpeg' : 'image/webp',
            },
          }),
      ),
    )
    const numeric = { data: [0.123456789, 2], width: 1, height: 1, type: 'Float32Array' }
    const source = documentWith(['https://cdn.test/a.jpg', 'b.webp', numeric])
    const bundle = await prepareFolderExport(source, 'https://game.test/')
    expect(bundle.files.size).toBe(2)
    expect([...bundle.files.keys()]).toEqual([
      expect.stringMatching(/\.jpg$/),
      expect.stringMatching(/\.webp$/),
    ])
    expect(bundle.json.images![2]!.url).toEqual(numeric)
    const folder = memoryFolder()
    await writeFolderExport(folder.directory, 'fire.json', bundle)
    await writeFolderExport(folder.directory, 'smoke.json', bundle)
    expect(folder.files.size).toBe(4)
    expect(folder.write.mock.calls.map(([path]) => path)).toEqual([
      ...bundle.files.keys(),
      'fire.json',
      'smoke.json',
    ])
    expect(JSON.parse(await folder.files.get('fire.json')!.text())).toEqual(bundle.json)
  })

  it.each([404, 403])('reports HTTP %i instead of emitting a broken package', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status })),
    )
    await expect(
      prepareFolderExport(documentWith(['a.png']), 'https://game.test/'),
    ).rejects.toThrow(String(status))
  })

  it('reports network/CORS failures and unsupported responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('CORS blocked'))
        .mockResolvedValue(new Response('<html/>', { headers: { 'Content-Type': 'text/html' } })),
    )
    await expect(
      prepareFolderExport(documentWith(['a.png']), 'https://game.test/'),
    ).rejects.toThrow('CORS blocked')
    await expect(
      prepareFolderExport(documentWith(['a.png']), 'https://game.test/'),
    ).rejects.toThrow('unsupported texture')
  })

  it('does not overwrite corrupt assets or replace JSON when asset writes fail', async () => {
    const bundle = {
      json: documentWith([]),
      files: new Map([['assets/textures/hash.png', new Blob(['image'])]]),
    }
    const folder = memoryFolder()
    folder.files.set('fire.json', new Blob(['old document']))
    folder.write.mockRejectedValueOnce(new Error('Disk full'))
    await expect(writeFolderExport(folder.directory, 'fire.json', bundle)).rejects.toThrow(
      'Disk full',
    )
    expect(folder.abort).toHaveBeenCalledOnce()
    expect(await folder.files.get('fire.json')!.text()).toBe('old document')
    folder.files.set('assets/textures/hash.png', new Blob(['corrupt']))
    await expect(writeFolderExport(folder.directory, 'fire.json', bundle)).rejects.toThrow(
      'corrupted',
    )
    expect(await folder.files.get('fire.json')!.text()).toBe('old document')
  })

  it('copies browsed textures without a JSON write, reusing identical bytes', async () => {
    const folder = memoryFolder()
    for (const type of ['image/png', 'image/jpeg']) {
      const file = new Blob(['texture'], { type })
      const path = await textureAssetPath(file)
      await writeFolderAssets(folder.directory, new Map([[path, file]]))
      await writeFolderAssets(folder.directory, new Map([[path, file]]))
      expect(await folder.files.get(path)!.text()).toBe('texture')
    }
    expect(folder.write).toHaveBeenCalledTimes(2)
    expect([...folder.files.keys()]).toEqual([
      expect.stringMatching(/[a-f0-9]{16}\.png$/),
      expect.stringMatching(/[a-f0-9]{16}\.jpg$/),
    ])
  })

  it('detects shortened-hash collisions within one document and across writes', async () => {
    vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(new Uint8Array(32).buffer)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: URL) =>
          new Response(url.pathname, { headers: { 'Content-Type': 'image/png' } }),
      ),
    )
    await expect(
      prepareFolderExport(documentWith(['a.png', 'b.png']), 'https://game.test/'),
    ).rejects.toThrow('hash collision')
    const folder = memoryFolder()
    const first = new Blob(['first'], { type: 'image/png' })
    const second = new Blob(['other'], { type: 'image/png' })
    const path = await textureAssetPath(first)
    await writeFolderAssets(folder.directory, new Map([[path, first]]))
    await expect(writeFolderAssets(folder.directory, new Map([[path, second]]))).rejects.toThrow(
      'conflicting',
    )
    expect(await folder.files.get(path)!.text()).toBe('first')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Zip,
  ZipDeflate,
  ZipPassThrough,
  zipSync,
  strToU8,
} from 'three/examples/jsm/libs/fflate.module.js'
import { readProjectZip } from '../src/project-zip'
import { readTextureFile } from '../src/local-files'
import { prepareFolderExport } from '../src/folder-export'
import { meshEffect } from './fixtures/mesh'

vi.mock('../src/local-files', async (original) => ({
  ...(await original<typeof import('../src/local-files')>()),
  readTextureFile: vi.fn(
    async (file: File) =>
      `data:${file.type};base64,${Buffer.from(await file.arrayBuffer()).toString('base64')}`,
  ),
}))
afterEach(() => vi.clearAllMocks())

const effect = (url: unknown = 'assets/textures/smoke.png') =>
  JSON.stringify({
    metadata: { version: 4.7, type: 'Object' },
    object: { type: 'Group', children: [{ type: 'ParticleEmitter' }] },
    images: [{ uuid: 'image', url }],
  })
const archive = (entries: Record<string, string>, level: 0 | 6 = 6) =>
  new File(
    [
      new Uint8Array(
        zipSync(
          Object.fromEntries(Object.entries(entries).map(([path, text]) => [path, strToU8(text)])),
          { level },
        ),
      ),
    ],
    'project.zip',
  )

describe('project ZIP import', () => {
  it('awaits progress callbacks and reports archive and document completion', async () => {
    const file = archive({ 'fire.json': effect(), 'assets/textures/smoke.png': 'image' })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const progress = vi.fn(() => gate)
    let completed = false
    const reading = readProjectZip(file, progress).then((result) => {
      completed = true
      return result
    })
    await vi.waitFor(() => expect(progress).toHaveBeenCalled())
    expect(completed).toBe(false)
    release()
    expect((await reading).effects).toHaveLength(1)
    expect(progress).toHaveBeenCalledWith('Unpacking ZIP', file.size, file.size)
    expect(progress).toHaveBeenLastCalledWith('Reading fire.json', 1, 1)
  })

  it('resolves external meshes from a wrapped project and reports missing/corrupt mesh files', async () => {
    const source = meshEffect('zip-mesh')
    const bundle = await prepareFolderExport(source.json, 'https://game.test/')
    const path = [...bundle.files.keys()][0]!
    const payload = await bundle.files.get(path)!.text()
    ;(bundle.json.geometries as Record<string, unknown>[])[0]!.url =
      'assets/meshes/triangle%20one.json'
    const json = JSON.stringify(bundle.json)
    const read = await readProjectZip(
      archive({ 'project/effect.json': json, 'project/assets/meshes/triangle one.json': payload }),
    )
    expect(read.effects[0]!.json.geometries).toEqual(source.json.geometries)
    const savedAgain = await prepareFolderExport(read.effects[0]!.json, 'https://game.test/')
    expect([...savedAgain.files.keys()]).toEqual([path])
    await expect(readProjectZip(archive({ 'effect.json': json }))).rejects.toThrow('Missing mesh')
    await expect(
      readProjectZip(
        archive({ 'effect.json': json, 'assets/meshes/triangle one.json': 'invalid' }),
      ),
    ).rejects.toThrow()
  })
  it.each([
    ['', 0],
    ['My Project/', 6],
  ] as const)(
    'opens a %s project with exact texture paths and preserves unused assets',
    async (prefix, level) => {
      const result = await readProjectZip(
        archive(
          Object.fromEntries(
            Object.entries({
              'fire.json': effect(['assets/textures/smoke.png', 'other/smoke.png']),
              'smoke.json': effect('assets/textures/spark%20two.jpg'),
              'assets/textures/smoke.png': 'smoke',
              'other/smoke.png': 'other',
              'assets/textures/spark two.jpg': 'spark',
              'assets/textures/unused.webp': 'unused',
              'assets/textures/duplicate.png': 'smoke',
              'notes.txt': 'not an effect',
            }).map(([path, text]) => [`${prefix}${path}`, text]),
          ),
          level,
        ),
      )
      expect(result.effects.map(({ path }) => path)).toEqual(['fire.json', 'smoke.json'])
      expect(result.effects[0]!.json.images![0]!.url).toEqual([
        `data:image/png;base64,${Buffer.from('smoke').toString('base64')}`,
        `data:image/png;base64,${Buffer.from('other').toString('base64')}`,
      ])
      expect(result.effects[1]!.json.images![0]!.url).toBe(
        `data:image/jpeg;base64,${Buffer.from('spark').toString('base64')}`,
      )
      expect(result.files.size).toBe(4)
      expect(result.textures.size).toBe(4)
      expect(
        [...result.files.keys()].every((path) =>
          /^assets\/textures\/[a-f0-9]{16}\.(png|jpg|webp)$/.test(path),
        ),
      ).toBe(true)
      expect(readTextureFile).toHaveBeenCalledTimes(5)
    },
  )

  it('preserves embedded numeric textures without requiring image files', async () => {
    const numeric = { data: [0.123456789, 2], width: 1, height: 1, type: 'Float32Array' }
    const result = await readProjectZip(archive({ 'effect.json': effect(numeric) }))
    expect(result.effects[0]!.json.images![0]!.url).toEqual(numeric)
    expect(result.files.size).toBe(0)
  })

  it('reads streamed ZIP data descriptors, directory entries, and Unicode project names', async () => {
    const chunks: Uint8Array<ArrayBuffer>[] = []
    const zip = new Zip((error, chunk) => {
      if (error) throw error
      chunks.push(new Uint8Array(chunk))
    })
    const directory = new ZipPassThrough('./')
    zip.add(directory)
    directory.push(new Uint8Array(), true)
    const json = new ZipDeflate('./Dự án/effect.json')
    zip.add(json)
    json.push(strToU8(effect('assets/textures/smoke.png')), true)
    const image = new ZipPassThrough('./Dự án/assets/textures/smoke.png')
    zip.add(image)
    image.push(strToU8('smoke'), true)
    zip.end()
    const result = await readProjectZip(new File(chunks, 'streamed.zip'))
    expect(result.effects).toHaveLength(1)
    expect(result.effects[0]!.path).toBe('effect.json')
    expect(result.files.size).toBe(1)
  })

  it.each([
    '../escape.json',
    '/absolute.json',
    'C:/drive.json',
    'assets/../../escape.png',
    'assets\\escape.png',
    'bad\u0000.png',
  ])('rejects unsafe archive path %s without extracting it', async (path) => {
    await expect(readProjectZip(archive({ [path]: 'data' }))).rejects.toThrow('Unsafe ZIP entry')
  })

  it('rejects duplicate paths instead of choosing an arbitrary version', async () => {
    const file = archive({
      'a.json': effect({ data: [], width: 0, height: 0, type: 'Uint8Array' }),
      'b.json': '{}',
    })
    const bytes = Buffer.from(await file.arrayBuffer())
    let offset = 0
    while ((offset = bytes.indexOf('b.json', offset)) !== -1) {
      bytes.write('a.json', offset)
      offset += 6
    }
    await expect(readProjectZip(new File([bytes], 'duplicate.zip'))).rejects.toThrow(
      'Duplicate ZIP entry',
    )
  })

  it('rejects oversized headers before decompressing entry data', async () => {
    const bytes = new Uint8Array(await archive({ 'effect.json': '{}' }).arrayBuffer())
    new DataView(bytes.buffer).setUint32(22, 64 * 1024 * 1024 + 1, true)
    await expect(readProjectZip(new File([bytes], 'oversized.zip'))).rejects.toThrow('64 MB')
  })

  it('rejects truncated, invalid, empty, and ambiguous projects', async () => {
    const bytes = await archive({ 'effect.json': '{}' }).arrayBuffer()
    await expect(readProjectZip(new File([bytes.slice(0, -10)], 'truncated.zip'))).rejects.toThrow(
      'truncated',
    )
    await expect(readProjectZip(new File(['not zip'], 'invalid.zip'))).rejects.toThrow('Invalid')
    await expect(readProjectZip(new File([], 'empty.zip'))).rejects.toThrow('1 byte')
    await expect(readProjectZip(archive({ 'notes.txt': 'hello' }))).rejects.toThrow('one project')
    await expect(
      readProjectZip(archive({ 'one/effect.json': '{}', 'two/effect.json': '{}' })),
    ).rejects.toThrow('one project')
  })

  it('reports invalid JSON, missing textures, and corrupt images without a partial result', async () => {
    await expect(readProjectZip(archive({ 'effect.json': 'not JSON' }))).rejects.toThrow()
    await expect(readProjectZip(archive({ 'effect.json': effect() }))).rejects.toThrow(
      'Missing texture',
    )
    vi.mocked(readTextureFile).mockRejectedValueOnce(new Error('Could not decode texture'))
    await expect(
      readProjectZip(archive({ 'effect.json': effect(), 'assets/textures/smoke.png': 'bad' })),
    ).rejects.toThrow('Could not decode')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readTextureFile, resolveLocalTextures } from '../src/local-files'
import type { QuarksDocument } from '../src/document'

const png = 'data:image/png;base64,aGVsbG8='
let readError = false
let decodeError = false
let width = 32

beforeEach(() => {
  readError = false
  decodeError = false
  width = 32
  vi.stubGlobal(
    'FileReader',
    class {
      result = png
      onload?: () => void
      onerror?: () => void
      readAsDataURL() {
        if (readError) this.onerror?.()
        else this.onload?.()
      }
    },
  )
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = width
      naturalHeight = 32
      onload?: () => void
      onerror?: () => void
      set src(_value: string) {
        if (decodeError) this.onerror?.()
        else this.onload?.()
      }
    },
  )
})
afterEach(() => vi.unstubAllGlobals())

const file = (name = 'smoke.png', size = 42) => ({ name, size }) as File

describe('local textures', () => {
  it('reads and decodes a raster image into an embeddable data URL', async () => {
    await expect(readTextureFile(file())).resolves.toBe(png)
  })
  it.each(['vector.svg', 'script.html', 'document.json', 'texture.exe'])(
    'rejects unsupported file %s',
    async (name) => {
      await expect(readTextureFile(file(name))).rejects.toThrow('Choose a PNG')
    },
  )
  it.each([0, 16 * 1024 * 1024 + 1])('rejects invalid file size %i', async (size) => {
    await expect(readTextureFile(file('smoke.png', size))).rejects.toThrow('16 MB')
  })
  it('reports file reading failures', async () => {
    readError = true
    await expect(readTextureFile(file())).rejects.toThrow('Could not read')
  })
  it('rejects corrupt or disguised images', async () => {
    decodeError = true
    await expect(readTextureFile(file())).rejects.toThrow('Could not decode')
  })
  it('rejects excessive dimensions before creating a GPU texture', async () => {
    width = 8193
    await expect(readTextureFile(file())).rejects.toThrow('8192')
  })
  it('resolves local filenames including URL encoding, but preserves remote and embedded images', () => {
    const urls = [
      'textures/smoke.png',
      '../smoke%20two.png?v=1',
      'https://cdn.test/smoke.png',
      '//cdn.test/smoke.png',
      png,
      'missing.png',
      '%XX.png',
    ]
    const json: QuarksDocument = {
      metadata: { version: 4.7, type: 'Object' },
      object: { type: 'Group' },
      images: urls.map((url) => ({ url })),
    }
    resolveLocalTextures(
      json,
      new Map([
        ['smoke.png', png],
        ['smoke two.png', png],
      ]),
    )
    expect(json.images?.map((image) => image.url)).toEqual([png, png, ...urls.slice(2)])
  })
  it('resolves image arrays and never substitutes a host URL for a local file', () => {
    const json: QuarksDocument = {
      metadata: { version: 4.7, type: 'Object' },
      object: { type: 'Group' },
      images: [{ url: ['a.png', 'b.png'] }, { url: { data: [1], width: 1, height: 1 } }],
    }
    resolveLocalTextures(
      json,
      new Map([
        ['a.png', png],
        ['b.png', 'https://cdn.test/b.png'],
      ]),
    )
    expect(json.images?.[0]?.url).toEqual([png, 'b.png'])
    expect(json.images?.[1]?.url).toEqual({ data: [1], width: 1, height: 1 })
  })
})

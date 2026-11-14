import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseQuarksDocument } from '../src/document'
import { resolveLocalTextures } from '../src/local-files'
import { prepareNativeDocument } from '../src/native-properties'

const demo = new URL('../demo/', import.meta.url)

describe('reference demo files', () => {
  it('ships exactly three effects and only their referenced textures', () => {
    expect(
      readdirSync(demo)
        .filter((file) => file.endsWith('.json'))
        .sort(),
    ).toEqual(['Fire.json', 'Lightning.json', 'Poison.json'])
    const referenced = new Set<string>()
    for (const name of ['Fire', 'Lightning', 'Poison']) {
      const json = parseQuarksDocument(
        JSON.parse(readFileSync(new URL(`${name}.json`, demo), 'utf8')),
      )
      expect(() => prepareNativeDocument(json)).not.toThrow()
      const textures = new Map<string, string>()
      expect(json.images?.length).toBeGreaterThan(0)
      for (const image of json.images!) {
        expect(image.url).toMatch(/^textures\/[a-z\d-]+\.png$/)
        const url = image.url as string
        const filename = url.slice('textures/'.length)
        const png = readFileSync(new URL(url, demo))
        expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
        expect(png.readUInt32BE(16)).toBeLessThanOrEqual(8192)
        expect(png.readUInt32BE(20)).toBeLessThanOrEqual(8192)
        textures.set(filename, `data:image/png;base64,${png.toString('base64')}`)
        referenced.add(filename)
      }
      resolveLocalTextures(json, textures)
      expect(
        json.images!.every((image) => String(image.url).startsWith('data:image/png;base64,')),
      ).toBe(true)
    }
    expect(readdirSync(new URL('textures/', demo)).sort()).toEqual([...referenced].sort())
  })
})

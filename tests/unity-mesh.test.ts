import { describe, expect, it } from 'vitest'
import { readUnityMesh } from '../src/unity-mesh'
import { meshFbx, meshObj } from './fixtures/unity-package'

const bytes = (text: string) => new TextEncoder().encode(text)

describe('Unity mesh geometry', () => {
  it('preserves UVs and does not bake OBJ node transforms or fetch its material library', async () => {
    const geometry = await readUnityMesh(bytes(meshObj), 'Triangle.obj', 'Triangle', 1, true)
    expect(Array.from(geometry.getAttribute('uv').array)).toEqual([0, 0, 1, 0, 0, 1])
    expect(geometry.getAttribute('position').count).toBe(3)
    geometry.dispose()
  })

  it('honors the FBX convert-file-units switch', async () => {
    const source = bytes(meshFbx.replace('"",100', '"",1'))
    const converted = await readUnityMesh(source, 'Triangle.fbx', 'Triangle', 2, true)
    const unconverted = await readUnityMesh(source, 'Triangle.fbx', 'Triangle', 2, false)
    expect(converted.getAttribute('position').getX(1)).toBeCloseTo(0.02)
    expect(unconverted.getAttribute('position').getX(1)).toBe(2)
    converted.dispose()
    unconverted.dispose()
  })

  it('does not guess between multiple meshes without fileID/name metadata', async () => {
    const source = `${meshObj}\no Other\nf 1/1 2/2 3/3\n`
    await expect(readUnityMesh(bytes(source), 'multi.obj', undefined, 1, true)).rejects.toThrow(
      'uniquely resolve',
    )
    const selected = await readUnityMesh(bytes(source), 'multi.obj', 'Other', 1, true)
    expect(selected.name).toBe('Other')
    selected.dispose()
  })

  it.each([
    ['non-finite vertices', meshObj.replace('v 1 0 0', 'v NaN 0 0'), 'invalid vertex attributes'],
    [
      'invalid triangle references',
      meshObj.replace('f 1/1 2/2 3/3', 'f 1/1 2/2 9/3'),
      'invalid vertex attributes',
    ],
    ['empty geometry', 'o Triangle\n', 'uniquely resolve'],
  ])('rejects %s', async (_label, source, message) => {
    await expect(readUnityMesh(bytes(source), 'Triangle.obj', 'Triangle', 1, true)).rejects.toThrow(
      message,
    )
  })

  it('rejects oversized sources, invalid import scales, and non-finite scaled geometry', async () => {
    await expect(
      readUnityMesh(new Uint8Array(16 * 1024 * 1024 + 1), 'large.fbx', undefined, 1, true),
    ).rejects.toThrow('16 MB')
    await expect(
      readUnityMesh(bytes(meshObj), 'Triangle.obj', 'Triangle', 0, true),
    ).rejects.toThrow('import scale')
    await expect(
      readUnityMesh(bytes(meshObj), 'Triangle.obj', 'Triangle', 1e100, true),
    ).rejects.toThrow('non-finite vertices')
  })
})

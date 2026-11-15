import { gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import {
  AdditiveBlending,
  ClampToEdgeWrapping,
  NearestFilter,
  RepeatWrapping,
  Scene,
  BufferGeometryLoader,
  Vector3,
  Euler,
  Quaternion,
} from 'three'
import { BatchedRenderer, ParticleSystem, QuarksLoader, RenderMode } from 'three.quarks'
import { readUnityPackage } from '../src/unity-package'
import { prepareNativeDocument, validateNative } from '../src/native-properties'
import { readTextureFile } from '../src/local-files'
import {
  materialGuid,
  meshFbx,
  meshGuid,
  meshObj,
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
  const unity = await readUnityPackage(packageFile({ ...entries, [`${prefabGuid}/asset`]: text }))
  return unity.convertPrefab(unity.prefabs[0]!)
}

// Feed decompressed chunks directly so size-limit tests do not allocate gigabyte fixtures.
function streamedPackage(chunks: Iterable<Uint8Array<ArrayBuffer>>): File {
  const iterator = chunks[Symbol.iterator]()
  return {
    name: 'streamed.unitypackage',
    size: 1,
    stream: () => ({
      pipeThrough: () =>
        new ReadableStream({
          pull(controller) {
            const { done, value } = iterator.next()
            if (done) controller.close()
            else controller.enqueue(value)
          },
        }),
    }),
  } as unknown as File
}

function meshEntries(
  source = meshFbx,
  extension = 'fbx',
): { text: string; entries: Record<string, string> } {
  const text = prefab.replace(
    'm_RenderMode: 0',
    `m_RenderMode: 4\n  m_Mesh: {fileID: 4300000, guid: ${meshGuid}, type: 3}`,
  )
  return {
    text,
    entries: {
      ...packageEntries(text),
      [`${meshGuid}/pathname`]: `Assets/Models/Triangle.${extension}`,
      [`${meshGuid}/asset`]: source,
      [`${meshGuid}/asset.meta`]:
        'ModelImporter:\n  fileIDToRecycleName: {4300000: Triangle}\n  meshes: {globalScale: 2, useFileScale: 1}',
    },
  }
}

describe('Unity package import', () => {
  it('awaits progress callbacks and reports the complete expanded byte count', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const progress = vi.fn(() => gate)
    let completed = false
    const reading = readUnityPackage(packageFile(packageEntries()), progress).then((unity) => {
      completed = true
      return unity
    })
    await vi.waitFor(() => expect(progress).toHaveBeenCalled())
    expect(completed).toBe(false)
    release()
    expect((await reading).prefabs).toEqual(['Assets/Effects/Fire.prefab'])
    expect(progress.mock.calls.at(-1)).toEqual([tar(packageEntries()).length])
  })

  it('reads packages larger than 512 MB without retaining ignored entries', async () => {
    const ignored = tar({ 'preview.png': new Uint8Array(1024 * 1024) }).subarray(0, -1024)
    function* chunks() {
      for (let i = 0; i < 513; i++) yield ignored
      yield tar(packageEntries())
    }
    const unity = await readUnityPackage(streamedPackage(chunks()))
    expect(unity.prefabs).toEqual(['Assets/Effects/Fire.prefab'])
    expect((await unity.convertPrefab(unity.prefabs[0]!)).particleCount).toBe(2)
  })

  it.each(['entries', 'padding'])('enforces the 1024 MB expanded limit for %s', async (kind) => {
    const bytes = new Uint8Array(1024 * 1024)
    const chunk = kind === 'entries' ? tar({ ignored: bytes }).subarray(0, -1024) : bytes
    function* chunks() {
      if (kind === 'padding') yield tar(packageEntries())
      for (let i = 0; i < 1024; i++) yield chunk
    }
    await expect(readUnityPackage(streamedPackage(chunks()))).rejects.toThrow('1024 MB')
  })

  it('validates the gzip checksum after the tar end marker', async () => {
    const bytes = new Uint8Array(gzipSync(tar(packageEntries())))
    bytes[bytes.length - 8]! ^= 1
    await expect(readUnityPackage(new File([bytes], 'corrupt.unitypackage'))).rejects.toThrow(
      'decompress',
    )
  })

  it.each([1, 511, 513, 4093])(
    'reads tar headers and assets split into %i-byte chunks',
    async (size) => {
      const bytes = tar(packageEntries())
      function* chunks() {
        for (let offset = 0; offset < bytes.length; offset += size)
          yield bytes.subarray(offset, offset + size)
      }
      const unity = await readUnityPackage(streamedPackage(chunks()))
      expect((await unity.convertPrefab(unity.prefabs[0]!)).particleCount).toBe(2)
    },
  )

  it.each(['\n00', '\r\n00', '\n', '\0'])(
    'accepts legacy and plain pathname endings %j',
    async (ending) => {
      const entries = packageEntries()
      for (const name of Object.keys(entries))
        if (name.endsWith('/pathname')) entries[name] += ending
      entries['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pathname'] = `Assets/Other.prefab${ending}`
      entries['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/asset'] = prefab
      const unity = await readUnityPackage(packageFile(entries))
      expect(unity.prefabs).toEqual(['Assets/Effects/Fire.prefab', 'Assets/Other.prefab'])
      expect((await unity.convertPrefab('Assets/Other.prefab')).particleCount).toBe(2)
    },
  )

  it.each(['../Fire.prefab\n00', 'Assets/Fire\nOther.prefab', 'Assets/Fire.prefab\n01'])(
    'still rejects unsafe or unrecognized multiline pathname %j',
    async (path) => {
      const entries = packageEntries()
      entries[`${prefabGuid}/pathname`] = path
      await expect(readUnityPackage(packageFile(entries))).rejects.toThrow('Unsafe')
    },
  )

  it.each([
    ['fbx', meshFbx],
    ['obj', meshObj],
  ])(
    'embeds %s mesh geometry without loading model textures or node transforms',
    async (extension, source) => {
      const { text, entries } = meshEntries(source, extension)
      delete entries[`${materialGuid}/asset`]
      const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed'))
      try {
        const { json, warnings } = await load(text, entries)
        const emitter = (json.object as any).children[0].children[1]
        expect(emitter.ps.renderMode).toBe(RenderMode.Mesh)
        const geometryJSON = (json.geometries as any[]).find(
          (g) => g.uuid === emitter.ps.instancingGeometry,
        )
        const geometry = new BufferGeometryLoader().parse(geometryJSON)
        expect(geometry.name).toBe('Triangle')
        expect(Array.from(geometry.getAttribute('position').array)).toEqual([
          0, 0, 0, 2, 0, 0, 0, 2, 2,
        ])
        expect(geometry.hasAttribute('normal')).toBe(true)
        expect(geometry.hasAttribute('uv')).toBe(true)
        expect((json.materials as any[]).map((m) => m.name)).not.toContain('Ignored')
        expect(warnings.join('\n')).not.toContain('Using a billboard')
        expect(fetch).not.toHaveBeenCalled()
        prepareNativeDocument(json)
        validateNative(json)
        const group = new QuarksLoader().parse(json)
        new Scene().add(group)
        const renderer = new BatchedRenderer()
        const systems: ParticleSystem[] = []
        group.traverse((node) => {
          if ('system' in node) systems.push(node.system as ParticleSystem)
        })
        for (const system of systems) renderer.addSystem(system)
        group.updateMatrixWorld(true)
        for (let i = 0; i < 30; i++) renderer.update(1 / 60)
        expect(
          systems.find((system) => system.renderMode === RenderMode.Mesh)!.particleNum,
        ).toBeGreaterThan(0)
        for (const system of systems) system.dispose()
        renderer.dispose()
        geometry.dispose()
      } finally {
        fetch.mockRestore()
      }
    },
  )

  it('resolves modern 64-bit mesh mappings and honors FBX file units', async () => {
    const { text, entries } = meshEntries(meshFbx.replace('"",100', '"",1'))
    entries[`${meshGuid}/asset.meta`] =
      'ModelImporter:\n  internalIDToNameTable:\n  - first: {43: 9007199254740993}\n    second: Triangle\n  globalScale: 2\n  useFileScale: 1'
    const { json } = await load(
      text.replace('m_Mesh: {fileID: 4300000', 'm_Mesh: {fileID: 9007199254740993'),
      entries,
    )
    const geometry = (json.geometries as any[]).find((g) => g.name === 'Triangle')
    expect(geometry.data.attributes.position.array[3]).toBeCloseTo(0.02)
  })

  it('shares repeated mesh geometry and warns about extra meshes and pivots', async () => {
    const { text, entries } = meshEntries()
    const renderer = text
      .slice(text.indexOf('--- !u!199'), text.indexOf('--- !u!1 &9007199254740996'))
      .replace('&9007199254740995', '&42')
      .replace(
        'm_GameObject: {fileID: 9007199254740992}',
        'm_GameObject: {fileID: 9007199254740996}',
      )
    const { json, warnings } = await load(
      `${text}${renderer}`.replace(
        'm_RenderMode: 4',
        'm_RenderMode: 4\n  m_Mesh1: {fileID: 4300000}\n  m_Pivot: {x: 1}',
      ),
      entries,
    )
    const group = (json.object as any).children[0]
    const first = group.children[1].ps.instancingGeometry
    const second = group.children[0].children[0].ps.instancingGeometry
    expect(first).toBe(second)
    expect((json.geometries as any[]).filter((geometry) => geometry.uuid === first)).toHaveLength(1)
    expect(warnings.join('\n')).toContain('only the first mesh is used')
    expect(warnings.join('\n')).toContain('pivot is not converted')
  })

  it('imports mesh XYZ start rotation and both scalar and XYZ lifetime rotations', async () => {
    const { text, entries } = meshEntries()
    for (const separate of [0, 1]) {
      const { json } = await load(
        text
          .replace(
            'startRotation: {',
            'rotation3D: 1\n    startRotationX: {scalar: 0.1}\n    startRotationY: {scalar: 0.2}\n    startRotation: {',
          )
          .replace(
            'RotationModule:\n    enabled: 1',
            `RotationModule:\n    enabled: 1\n    separateAxes: ${separate}\n    x: {scalar: 0.4}\n    y: {scalar: 0.5}`,
          ),
        entries,
      )
      const ps = (json.object as any).children[0].children[1].ps
      expect(ps.startRotation).toMatchObject({
        type: 'Euler',
        eulerOrder: 'YXZ',
        angleX: { value: -0.1 },
        angleY: { value: 0.2 },
        angleZ: { value: Math.PI - 0.3 },
      })
      const rotation = ps.behaviors.find((b: any) => b.type === 'Rotation3DOverLife')
      expect(rotation.angularVelocity).toMatchObject({
        type: 'Euler',
        angleX: { value: separate ? 0.4 : 0 },
        angleY: { value: separate ? -0.5 : 0 },
        angleZ: { value: -0.2 },
      })
    }
  })

  it('converts magnitude velocity limits and reports unsupported axis limits and drag', async () => {
    const text = prefab.replace(
      'NoiseModule: {enabled: 1}',
      'ClampVelocityModule:\n    enabled: 1\n    magnitude: {scalar: 2}\n    dampen: 0.6\n    drag: {scalar: 0.2}',
    )
    const { json, warnings } = await load(text)
    const ps = (json.object as any).children[0].children[1].ps
    const limit = ps.behaviors.find((b: any) => b.type === 'LimitSpeedOverLife')
    expect(limit).toMatchObject({ dampen: 0.6, speed: { type: 'PiecewiseBezier' } })
    expect(limit.speed.functions[0].function.p0).toBe(2)
    expect(warnings.join('\n')).toContain('drag is not converted')
    expect(warnings.join('\n')).not.toContain('ClampVelocityModule is enabled but not converted')
    const separate = await load(text.replace('dampen: 0.6', 'separateAxis: 1\n    dampen: 0.6'))
    expect(separate.warnings.join('\n')).toContain('separate-axis limits are not converted')
  })

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'preserves mesh start orientation with rotation3D=%s and worldSpace=%s without reflected emitter scale',
    async (rotation3D, worldSpace) => {
      const source = meshEntries()
      const text = source.text
        .replace('moveWithTransform: 1', `moveWithTransform: ${Number(!worldSpace)}`)
        .replace(
          'startRotation: {',
          `rotation3D: ${Number(rotation3D)}\n    startRotationX: {scalar: 0.1}\n    startRotationY: {scalar: 0.2}\n    startRotation: {`,
        )
      delete source.entries[`${materialGuid}/asset`]
      const { json } = await load(text, source.entries)
      const group = new QuarksLoader().parse(json)
      new Scene().add(group)
      group.updateMatrixWorld(true)
      const renderer = new BatchedRenderer()
      const systems: ParticleSystem[] = []
      group.traverse((node) => {
        if ('system' in node) systems.push(node.system as ParticleSystem)
      })
      for (const system of systems) {
        system.behaviors = []
        renderer.addSystem(system)
      }
      try {
        renderer.update(1 / 60)
        const system = systems.find((s) => s.renderMode === RenderMode.Mesh)!
        const expected = new Quaternion()
          .setFromAxisAngle(new Vector3(0, 1, 0), Math.PI)
          .multiply(
            rotation3D
              ? new Quaternion().setFromEuler(new Euler(0.1, -0.2, -0.3, 'YXZ'))
              : new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -0.3),
          )
        expect(system.emitter.matrixWorld.determinant()).toBeGreaterThan(0)
        expect(system.particleNum).toBeGreaterThan(0)
        const rotation = system.particles[0]!.rotation
        if (typeof rotation !== 'object') throw new Error('Expected mesh particle quaternion')
        const actual = new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w)
        if (!worldSpace) actual.premultiply(system.emitter.getWorldQuaternion(new Quaternion()))
        expect(Math.abs(expected.dot(actual))).toBeCloseTo(1, 10)
      } finally {
        for (const system of systems) system.dispose()
        renderer.dispose()
      }
    },
  )

  it.each([0, 2, 4, 10, 17])(
    'preserves a partial emission arc and reflected forward axis for Unity shape %i',
    async (type) => {
      const text = prefab
        .replace('type: 4\n    angle: 30', `type: ${type}\n    radiusThickness: 0\n    angle: 30`)
        .replace('arc: {value: 180}', 'arc: {value: 90}')
      const entries = packageEntries(text)
      delete entries[`${materialGuid}/asset`]
      const { json } = await load(text, entries)
      const group = new QuarksLoader().parse(json)
      new Scene().add(group)
      group.updateMatrixWorld(true)
      const renderer = new BatchedRenderer()
      const systems: ParticleSystem[] = []
      group.traverse((node) => {
        if ('system' in node) systems.push(node.system as ParticleSystem)
      })
      for (const system of systems) renderer.addSystem(system)
      try {
        renderer.update(1 / 60)
        const system = systems.find((s) => s.particleNum > 0)!
        const particle = system.particles[0]!
        const random = vi.spyOn(Math, 'random').mockReturnValue(0.37)
        try {
          system.emitterShape.initialize(particle, system.emissionState)
        } finally {
          random.mockRestore()
        }
        const position = new Vector3(
          particle.position.x,
          particle.position.y,
          particle.position.z,
        ).applyQuaternion(system.emitter.quaternion)
        const velocity = new Vector3(
          particle.velocity.x,
          particle.velocity.y,
          particle.velocity.z,
        ).applyQuaternion(system.emitter.quaternion)
        expect(position.x).toBeGreaterThan(0)
        expect(position.y).toBeGreaterThan(0)
        expect(Math.atan2(position.y, position.x)).toBeCloseTo((0.37 * Math.PI) / 2, 10)
        if (type === 2 || type === 17) expect(position.z).toBeLessThan(0)
        if (type === 4) expect(velocity.z).toBeLessThan(0)
      } finally {
        for (const system of systems) system.dispose()
        renderer.dispose()
      }
    },
  )

  it('applies the mesh basis offset to random ranges and curve values, but not curve slopes', async () => {
    const source = meshEntries()
    const convert = async (rotation: string) => {
      const { json } = await load(
        source.text.replace(
          'startRotation: {minMaxState: 0, scalar: 0.3}',
          `rotation3D: 1\n    startRotation: ${rotation}`,
        ),
        source.entries,
      )
      return (json.object as any).children[0].children[1].ps.startRotation.angleZ
    }
    expect(await convert('{minMaxState: 3, scalar: 0.3, minScalar: -0.2}')).toEqual({
      type: 'IntervalValue',
      a: Math.PI - 0.3,
      b: Math.PI + 0.2,
    })
    const curve = await convert(
      '{minMaxState: 1, scalar: 0.3, maxCurve: {m_Curve: [{time: 0, value: 0, outSlope: 1}, {time: 1, value: 1, inSlope: 1}]}}',
    )
    for (let i = 0; i < 4; i++)
      expect(curve.functions[0].function[`p${i}`]).toBeCloseTo(Math.PI - i * 0.1, 12)
  })

  it.each([
    [
      'missing asset',
      (entries: Record<string, string>) => {
        delete entries[`${meshGuid}/asset`]
      },
      'not in the package',
    ],
    [
      'unresolved fileID',
      (entries: Record<string, string>) => {
        entries[`${meshGuid}/asset.meta`] =
          'ModelImporter:\n  fileIDToRecycleName: {4300002: Triangle}'
      },
      'no name mapping',
    ],
    [
      'wrong mesh name',
      (entries: Record<string, string>) => {
        entries[`${meshGuid}/asset.meta`] =
          'ModelImporter:\n  fileIDToRecycleName: {4300000: Other}'
      },
      'Cannot uniquely resolve',
    ],
    [
      'invalid FBX',
      (entries: Record<string, string>) => {
        entries[`${meshGuid}/asset`] = 'not an FBX'
      },
      'FBXLoader',
    ],
    [
      'unsupported source',
      (entries: Record<string, string>) => {
        entries[`${meshGuid}/pathname`] = 'Assets/Triangle.blend'
      },
      'Only FBX and OBJ',
    ],
  ])('warns and retains billboard fallback for %s', async (_label, modify, message) => {
    const { text, entries } = meshEntries()
    modify(entries)
    const { json, warnings } = await load(text, entries)
    expect((json.object as any).children[0].children[1].ps.renderMode).toBe(RenderMode.BillBoard)
    expect(warnings.join('\n')).toContain(message)
    expect(warnings.join('\n')).toContain('Using a billboard instead')
  })

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
    expect(ps.shape).toMatchObject({ type: 'cone', radius: 0.25, arc: -Math.PI })
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

  it.each([
    ['stretched rays', -6, 1.3, 1],
    ['dust', -8, 3.3291566, 0],
    ['outward particles', 4, 2, 0],
  ])(
    'keeps world-space %s velocity radial after handedness conversion and a JSON round trip',
    async (_, speed, radius, mode) => {
      const text = prefab
        .replace('moveWithTransform: 1', 'moveWithTransform: 0')
        .replace('type: 4\n    angle: 30', 'type: 0\n    radiusThickness: 0\n    angle: 30')
        .replace('radius: {value: 0.25}', `radius: {value: ${radius}}`)
        .replace('startSpeed: {minMaxState: 0, scalar: 4}', `startSpeed: {scalar: ${speed}}`)
        .replace('m_RenderMode: 0', `m_RenderMode: ${mode}`)
      const entries = packageEntries(text)
      delete entries[`${materialGuid}/asset`]
      const { json } = await load(text, entries)
      prepareNativeDocument(json)
      const group = new QuarksLoader().parse(JSON.parse(JSON.stringify(json)))
      const renderer = new BatchedRenderer()
      const systems: ParticleSystem[] = []
      group.traverse((node) => {
        if ('system' in node) systems.push(node.system as ParticleSystem)
      })
      new Scene().add(group)
      for (const system of systems) renderer.addSystem(system)
      group.updateMatrixWorld(true)
      try {
        renderer.update(1 / 60)
        const system = systems.find((s) => s.worldSpace)!
        const center = system.emitter.getWorldPosition(new Vector3())
        expect(system.particleNum).toBeGreaterThan(0)
        for (const particle of system.particles.slice(0, system.particleNum)) {
          const radial = new Vector3(particle.position.x, particle.position.y, particle.position.z)
            .sub(center)
            .normalize()
          const velocity = new Vector3(
            particle.velocity.x,
            particle.velocity.y,
            particle.velocity.z,
          ).normalize()
          expect(radial.dot(velocity)).toBeCloseTo(Math.sign(speed), 8)
        }
      } finally {
        for (const system of systems) system.dispose()
        renderer.dispose()
      }
    },
  )

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

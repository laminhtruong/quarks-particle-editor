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
import {
  BatchedRenderer,
  EmitSubParticleSystem,
  ParticleSystem,
  QuarksLoader,
  RenderMode,
  SubParticleEmitMode,
} from 'three.quarks'
import { readUnityPackage } from '../src/unity-package'
import { prepareNativeDocument, validateNative } from '../src/native-properties'
import { readTextureFile } from '../src/local-files'
import { prepareFolderExport } from '../src/folder-export'
import { readMeshJson, resolveMeshAssets } from '../src/mesh-assets'
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

  it.each([
    ['10210', 'Quad', [1, 1, 0]],
    ['10209', 'Plane', [10, 0, 10]],
    ['10202', 'Cube', [1, 1, 1]],
  ])(
    'resolves Unity built-in %s (%s) without an archive asset and preserves it through folder export',
    async (id, name, bounds) => {
      const text = prefab.replace(
        'm_RenderMode: 0',
        `m_RenderMode: 4\n  m_Mesh: {fileID: ${id}, guid: 0000000000000000e000000000000000, type: 0}`,
      )
      const entries = packageEntries(text)
      delete entries[`${materialGuid}/asset`]
      const { json, warnings } = await load(text, entries)
      expect(warnings.join('\n')).not.toContain('Using a billboard')
      const bundle = await prepareFolderExport(json, 'https://game.test/')
      expect(bundle.files.size).toBe(1)
      await resolveMeshAssets(bundle.json, (path) => readMeshJson(bundle.files.get(path)!))
      prepareNativeDocument(bundle.json)
      validateNative(bundle.json)
      const root = new QuarksLoader().parse(JSON.parse(JSON.stringify(bundle.json)))
      const systems: ParticleSystem[] = []
      root.traverse((node) => {
        if ('system' in node) systems.push(node.system as ParticleSystem)
      })
      const system = systems.find((system) => system.renderMode === RenderMode.Mesh)!
      expect(system).toBeDefined()
      const geometry = system.instancingGeometry
      expect(geometry.name).toBe(name)
      geometry.computeBoundingBox()
      const size = geometry.boundingBox!.getSize(new Vector3())
      bounds.forEach((expected, axis) => expect(size.getComponent(axis)).toBeCloseTo(expected, 8))
      expect(geometry.hasAttribute('normal')).toBe(true)
      expect(geometry.hasAttribute('uv')).toBe(true)
      for (const system of systems) system.dispose()
    },
  )

  it('keeps a built-in quad on the ground instead of camera-facing when XYZ start rotation is enabled', async () => {
    const text = prefab
      .replace(
        'm_RenderMode: 0',
        'm_RenderMode: 4\n  m_Mesh: {fileID: 10210, guid: 0000000000000000e000000000000000, type: 0}',
      )
      .replace(
        'startRotation: {minMaxState: 0, scalar: 0.3}',
        `rotation3D: 1\n    startRotationX: {scalar: ${Math.PI / 2}}\n    startRotationY: {minMaxState: 3, minScalar: 0, scalar: 6.283185}\n    startRotation: {scalar: 0}`,
      )
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
    for (const system of systems) {
      system.behaviors = []
      renderer.addSystem(system)
    }
    try {
      renderer.update(1 / 60)
      const system = systems.find((system) => system.renderMode === RenderMode.Mesh)!
      expect(system).toBeDefined()
      expect(system.particleNum).toBeGreaterThan(0)
      for (const particle of system.particles.slice(0, system.particleNum)) {
        const rotation = particle.rotation
        if (typeof rotation !== 'object') throw new Error('Expected mesh particle quaternion')
        const orientation = new Quaternion(
          rotation.x,
          rotation.y,
          rotation.z,
          rotation.w,
        ).premultiply(system.emitter.getWorldQuaternion(new Quaternion()))
        const normal = new Vector3(0, 0, -1).applyQuaternion(orientation)
        expect(Math.abs(normal.y)).toBeCloseTo(1, 8)
      }
    } finally {
      for (const system of systems) system.dispose()
      renderer.dispose()
    }
  })

  it.each([
    [meshGuid, '10210'],
    ['0000000000000000e000000000000000', '19999'],
  ])('does not treat unknown mesh reference %s/%s as a built-in quad', async (guid, id) => {
    const text = prefab.replace(
      'm_RenderMode: 0',
      `m_RenderMode: 4\n  m_Mesh: {fileID: ${id}, guid: ${guid}, type: 0}`,
    )
    const { json, warnings } = await load(text)
    expect((json.object as any).children[0].children[1].ps.renderMode).toBe(RenderMode.BillBoard)
    expect(warnings.join('\n')).toContain('Using a billboard')
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
      'NoiseModule: {enabled: 0}',
      'ClampVelocityModule:\n    enabled: 1\n    magnitude: {scalar: 2}\n    dampen: 0.6\n    drag: {scalar: 0.2}',
    )
    const { json, warnings } = await load(text)
    const ps = (json.object as any).children[0].children[1].ps
    const limit = ps.behaviors.find((b: any) => b.type === 'LimitSpeedOverLife')
    expect(limit).toMatchObject({ dampen: 0.6, speed: { type: 'ConstantValue', value: 2 } })
    expect(warnings.join('\n')).toContain('drag is not converted')
    expect(warnings.join('\n')).not.toContain('ClampVelocityModule is enabled but not converted')
    const separate = await load(text.replace('dampen: 0.6', 'separateAxis: 1\n    dampen: 0.6'))
    expect(separate.warnings.join('\n')).toContain('separate-axis limits are not converted')
  })

  it('converts force, noise and rotation-by-speed modules Quarks can represent', async () => {
    const forceText = prefab.replace(
      'NoiseModule: {enabled: 0}',
      'ForceModule:\n    enabled: 1\n    x: {scalar: 1}\n    y: {scalar: 2}\n    z: {scalar: 3}\n    inWorldSpace: 1',
    )
    const force = await load(forceText)
    const forcePS = (force.json.object as any).children[0].children[1].ps
    expect(forcePS.behaviors.find((b: any) => b.type === 'ForceOverLife')).toMatchObject({
      x: { value: 1 },
      y: { value: 2 },
      z: { value: -3 },
    })
    expect(force.warnings.join('\n')).not.toContain('ForceModule is enabled but not converted')
    // A local force on an unrotated GameObject is the same reflected world vector.
    const localForce = await load(forceText.replace('inWorldSpace: 1', 'inWorldSpace: 0'))
    const localPS = (localForce.json.object as any).children[0].children[1].ps
    expect(localPS.behaviors.find((b: any) => b.type === 'ForceOverLife')).toMatchObject({
      x: { value: 1 },
      y: { value: 2 },
      z: { value: -3 },
    })
    expect(localForce.warnings.join('\n')).toContain('local-space direction is baked')
    expect(localForce.warnings.join('\n')).not.toContain('ForceModule is enabled but not converted')

    const noise = await load(
      prefab.replace(
        'NoiseModule: {enabled: 0}',
        'NoiseModule:\n    enabled: 1\n    strength: {scalar: 2}\n    frequency: 0.5\n    positionAmount: {scalar: 0.75}\n    rotationAmount: {scalar: 0.25}',
      ),
    )
    const noisePS = (noise.json.object as any).children[0].children[1].ps
    expect(noisePS.behaviors.find((b: any) => b.type === 'Noise')).toMatchObject({
      power: { value: 2 },
      frequency: { value: 0.5 },
      positionAmount: { value: 0.75 },
      rotationAmount: { value: 0.25 },
    })
    expect(noise.warnings.join('\n')).not.toContain('NoiseModule is enabled but not converted')

    const rotation = await load(
      prefab.replace(
        'NoiseModule: {enabled: 0}',
        'RotationBySpeedModule:\n    enabled: 1\n    curve: {scalar: 0.25}\n    range: {x: 2, y: 8}',
      ),
    )
    const rotationPS = (rotation.json.object as any).children[0].children[1].ps
    expect(rotationPS.behaviors.find((b: any) => b.type === 'RotationBySpeed')).toMatchObject({
      angularVelocity: { value: -0.25 },
      speedRange: { a: 2, b: 8 },
    })
    expect(rotation.warnings.join('\n')).not.toContain(
      'RotationBySpeedModule is enabled but not converted',
    )
  })

  it('keeps warnings for modules without an equivalent Quarks behavior', async () => {
    const { warnings } = await load(
      prefab.replace(
        'NoiseModule: {enabled: 0}',
        'InheritVelocityModule: {enabled: 1}\n  CollisionModule: {enabled: 1}',
      ),
    )
    expect(warnings.join('\n')).toContain('InheritVelocityModule is enabled but not converted')
    expect(warnings.join('\n')).toContain('CollisionModule is enabled but not converted')
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
        .replace('moveWithTransform: 1', `moveWithTransform: ${Number(worldSpace)}`)
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

  it.each([
    [0.5, 0.25, true],
    [2, -3, false],
  ])(
    'preserves Edge radius %s and upward speed %s (world space: %s) through folder export',
    async (radius, speed, worldSpace) => {
      const text = prefab
        .replace('type: 4\n    angle: 30', 'type: 12\n    angle: 30')
        .replace('radius: {value: 0.25}', `radius: {value: ${radius}}`)
        .replace('startSpeed: {minMaxState: 0, scalar: 4}', `startSpeed: {scalar: ${speed}}`)
        .replace('moveWithTransform: 1', `moveWithTransform: ${Number(worldSpace)}`)
      const entries = packageEntries(text)
      delete entries[`${materialGuid}/asset`]
      const { json, warnings } = await load(text, entries)
      expect(warnings.join('\n')).not.toContain('unsupported')
      const bundle = await prepareFolderExport(json, 'https://game.test/')
      prepareNativeDocument(bundle.json)
      validateNative(bundle.json)
      const group = new QuarksLoader().parse(JSON.parse(JSON.stringify(bundle.json)))
      new Scene().add(group)
      group.updateMatrixWorld(true)
      const renderer = new BatchedRenderer()
      const systems: ParticleSystem[] = []
      group.traverse((node) => {
        if ('system' in node) systems.push(node.system as ParticleSystem)
      })
      systems.forEach((system) => renderer.addSystem(system))
      try {
        renderer.update(1 / 60)
        const system = systems.find((system) => system.particleNum > 0)!
        const particle = system.particles[0]!
        for (const sample of [0, 0.1, 0.5, 0.9, 1 - Number.EPSILON]) {
          const random = vi.spyOn(Math, 'random').mockReturnValue(sample)
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
          expect(position.x).toBeCloseTo((2 * sample - 1) * radius, 6)
          expect(position.y).toBeCloseTo(0, 10)
          expect(position.z).toBeCloseTo(0, 10)
          expect(velocity.x).toBeCloseTo(0, 10)
          expect(velocity.y).toBeCloseTo(speed, 10)
          expect(velocity.z).toBeCloseTo(0, 10)
        }
        system.restart()
        for (let i = 0; i < 12; i++) renderer.update(1 / 60)
        for (const p of system.particles.slice(0, system.particleNum)) {
          const origin = worldSpace ? system.emitter.getWorldPosition(new Vector3()) : new Vector3()
          const orientation = worldSpace
            ? system.emitter.getWorldQuaternion(new Quaternion()).invert()
            : new Quaternion()
          const local = new Vector3(p.position.x, p.position.y, p.position.z)
            .sub(origin)
            .applyQuaternion(orientation)
          expect(Math.abs(local.x)).toBeLessThanOrEqual(radius)
          expect(local.y).toBeCloseTo(0, 8)
          expect(local.z * Math.sign(speed)).toBeGreaterThanOrEqual(0)
        }
      } finally {
        systems.forEach((system) => system.dispose())
        renderer.dispose()
      }
    },
  )

  it('warns when Edge traversal settings cannot be represented by random grid sampling', async () => {
    const { warnings } = await load(
      prefab
        .replace('type: 4\n    angle: 30', 'type: 12\n    angle: 30')
        .replace('radius: {value: 0.25}', 'radius: {value: 0.25, mode: 1, spread: 0.1}'),
    )
    expect(warnings.join('\n')).toContain('Edge traversal modes and spread')
  })

  it('keeps the explicit unsupported fallback and mesh rotation for Edge mesh particles', async () => {
    const { text, entries } = meshEntries()
    delete entries[`${materialGuid}/asset`]
    const { json, warnings } = await load(
      text.replace('type: 4\n    angle: 30', 'type: 12\n    angle: 30'),
      entries,
    )
    expect(warnings.join('\n')).toContain('Shape type 12 is unsupported; using point emission.')
    const group = new QuarksLoader().parse(json)
    group.traverse((node) => {
      if ('system' in node) {
        const system = node.system as ParticleSystem
        expect(system.emitterShape.type).toBe('point')
        expect(system.emitter.rotation.x).toBeCloseTo(Math.PI)
        system.dispose()
      }
    })
  })

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
    const { json, warnings, particleCount } = await load(
      prefab.replace('NoiseModule: {enabled: 0}', 'NoiseModule: {enabled: 1}'),
    )
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
    // Two Unity cycles become two native bursts: Quarks ignores burst cycle/interval.
    expect(ps.emissionBursts).toHaveLength(2)
    expect(ps.emissionBursts[0]).toMatchObject({
      time: 0.5,
      cycle: 1,
      probability: 0.8,
      count: { type: 'IntervalValue', a: 4, b: 8 },
    })
    expect(ps.emissionBursts[1].time).toBeCloseTo(0.8)
    expect(ps.behaviors.map((b: any) => b.type)).toEqual([
      'ColorOverLife',
      'SizeOverLife',
      'RotationOverLife',
      'Noise',
      'FrameOverLife',
    ])
    const size = ps.behaviors[1].size.functions[0].function
    expect(size).toMatchObject({ p0: 0, p1: 2 / 3, p3: 2 })
    expect(size.p2).toBeCloseTo(4 / 3)
    expect(ps.startTileIndex.value).toBe(2)
    expect([ps.uTileCount, ps.vTileCount]).toEqual([4, 2])
    expect(ps.behaviors[4].frame.functions[0].function.p0).toBeCloseTo(2)
    expect(ps.behaviors[4].frame.functions[0].function.p3).toBeCloseTo(9.992)
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
    expect(ps.behaviors.map((b: any) => b.type)).toContain('Noise')
    expect(warnings.join('\n')).not.toContain('NoiseModule is enabled but not converted')
    expect(warnings.join('\n')).toContain('Particles/Additive')
    expect(root.userData.unityImport.warnings).toEqual(warnings)
    expect(JSON.stringify(json)).not.toContain('9007199254740993n')
    expect(() => {
      prepareNativeDocument(json)
      validateNative(json)
    }).not.toThrow()
  })

  it('keeps a non-first start frame when Frame over Time is constant zero', async () => {
    const text = prefab
      .replace(
        'startFrame: {minMaxState: 0, scalar: 0.25}',
        'startFrame: {minMaxState: 0, scalar: 0.5}',
      )
      .replace(
        /frameOverTime:\n      minMaxState: 1\n      scalar: 0\.999\n      maxCurve:\n        m_Curve:\n        - \{time: 0, value: 0, outSlope: 1\}\n        - \{time: 1, value: 1, inSlope: 1\}/,
        'frameOverTime: {minMaxState: 0, scalar: 0}',
      )
    const { json } = await load(text)
    const ps = (json.object as any).children[0].children[1].ps
    // A constant frame is a start tile; FrameOverLife would be redundant.
    expect(ps.startTileIndex.value).toBe(4)
    expect(ps.behaviors.some((behavior: any) => behavior.type === 'FrameOverLife')).toBe(false)
  })

  it('loads and simulates the converted document with stock Quarks', async () => {
    const entries = packageEntries()
    delete entries[`${materialGuid}/asset`]
    const text = prefab.replace(
      'NoiseModule: {enabled: 0}',
      'ForceModule:\n    enabled: 1\n    x: {scalar: 1}\n    inWorldSpace: 1\n  NoiseModule: {enabled: 1}\n  RotationBySpeedModule:\n    enabled: 1\n    curve: {scalar: 0.1}\n    range: {x: 0, y: 8}',
    )
    const { json } = await load(text, entries)
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

  it('keeps per-particle random lifetime constants and phase-shifts looping start delays', async () => {
    const text = prefab
      .replace(
        'minMaxState: 1\n      scalar: 2',
        'minMaxState: 3\n      minScalar: 1\n      scalar: 2',
      )
      .replace(
        'NoiseModule: {enabled: 0}',
        'NoiseModule: {enabled: 0}\n  startDelay: {minMaxState: 0, scalar: 2}',
      )
    const result = await load(text)
    expect(result.warnings.join('\n')).not.toContain('random constants')
    expect(result.warnings.join('\n')).toContain('first looping cycle begins immediately')
    const emitter = (result.json.object as any).children[0].children[1]
    expect(emitter.ps.emissionBursts.map((burst: any) => burst.time)).toEqual([2.5, 2.8])
    expect(emitter.ps.behaviors[1].size).toEqual({ type: 'IntervalValue', a: 1, b: 2 })
  })

  it('applies Unity gravity as world-down acceleration in rotated local simulation', async () => {
    const text = prefab
      .replace('moveWithTransform: 1', 'moveWithTransform: 0')
      .replace(
        'm_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
        'm_LocalRotation: {x: -0.7071068, y: 0, z: 0, w: 0.7071068}',
      )
      .replace('startSpeed: {minMaxState: 0, scalar: 4}', 'startSpeed: {minMaxState: 0, scalar: 0}')
      .replace(
        '    startColor:',
        '    gravityModifier: {minMaxState: 0, scalar: 2}\n    startColor:',
      )
    const entries = packageEntries(text)
    delete entries[`${materialGuid}/asset`]
    const { json, warnings } = await load(text, entries)
    expect(warnings.join('\n')).toContain('Unity default gravity')
    const emitterJson = (json.object as any).children[0].children[1]
    const gravity = emitterJson.ps.behaviors.find(
      (behavior: any) => behavior.type === 'ForceOverLife',
    )
    expect(gravity.y).toEqual({ type: 'ConstantValue', value: -19.62 })
    const ranged = await load(
      text.replace(
        'gravityModifier: {minMaxState: 0, scalar: 2}',
        'gravityModifier: {minMaxState: 3, minScalar: 0.5, scalar: 2}',
      ),
      entries,
    )
    const rangedGravity = (ranged.json.object as any).children[0].children[1].ps.behaviors.find(
      (behavior: any) => behavior.type === 'ForceOverLife',
    )
    expect(rangedGravity.y).toEqual({ type: 'IntervalValue', a: -19.62, b: -4.905 })

    const group = new QuarksLoader().parse(json)
    new Scene().add(group)
    group.updateMatrixWorld(true)
    const renderer = new BatchedRenderer()
    const systems: ParticleSystem[] = []
    group.traverse((node) => {
      if ('system' in node) systems.push(node.system as ParticleSystem)
    })
    systems.forEach((system) => renderer.addSystem(system))
    try {
      for (let i = 0; i < 12; i++) renderer.update(1 / 60)
      const system = systems.find((item) =>
        item.behaviors.some((behavior) => behavior.type === 'ForceOverLife'),
      )!
      expect(system.particleNum).toBeGreaterThan(0)
      expect(system.worldSpace).toBe(false)
      const rotation = system.emitter.getWorldQuaternion(new Quaternion())
      for (const particle of system.particles.slice(0, system.particleNum)) {
        const velocity = new Vector3(
          particle.velocity.x,
          particle.velocity.y,
          particle.velocity.z,
        ).applyQuaternion(rotation)
        expect(velocity.x).toBeCloseTo(0, 6)
        expect(velocity.y).toBeLessThan(0)
        expect(velocity.z).toBeCloseTo(0, 6)
      }
    } finally {
      systems.forEach((system) => system.dispose())
      renderer.dispose()
    }
  })

  it.each([
    [0, false],
    [1, true],
    [2, false],
  ])('maps Unity simulation-space enum %i correctly', async (unitySpace, worldSpace) => {
    const { json, warnings } = await load(
      prefab.replace('moveWithTransform: 1', `moveWithTransform: ${unitySpace}`),
    )
    const emitter = (json.object as any).children[0].children[1]
    expect(emitter.ps.worldSpace).toBe(worldSpace)
    if (unitySpace === 2)
      expect(warnings.join('\n')).toContain('Custom simulation-space transform is not converted')
  })

  it('keeps world-space distance emissions along a moving group path', async () => {
    const text = prefab
      .replace(
        'rateOverTime: {minMaxState: 0, scalar: 20}',
        'rateOverTime: {minMaxState: 0, scalar: 0}',
      )
      .replace('startSpeed: {minMaxState: 0, scalar: 4}', 'startSpeed: {minMaxState: 0, scalar: 0}')
    const { json } = await load(text)
    const probe = structuredClone(json)
    delete probe.images
    delete probe.textures
    for (const material of probe.materials as Record<string, unknown>[]) delete material.map
    const group = new QuarksLoader().parse(probe)
    new Scene().add(group)
    const renderer = new BatchedRenderer()
    const systems: ParticleSystem[] = []
    group.traverse((node) => {
      if ('system' in node) systems.push(node.system as ParticleSystem)
    })
    systems.forEach((system) => renderer.addSystem(system))
    const system = systems.find((item) => item.worldSpace)!
    try {
      group.updateMatrixWorld(true)
      renderer.update(1 / 60)
      for (let i = 1; i <= 20; i++) {
        group.position.x = i * 0.2
        group.updateMatrixWorld(true)
        renderer.update(1 / 60)
      }
      const x = system.particles.slice(0, system.particleNum).map((particle) => particle.position.x)
      expect(system.particleNum).toBeGreaterThanOrEqual(5)
      expect(Math.max(...x) - Math.min(...x)).toBeGreaterThan(1.5)
    } finally {
      systems.forEach((item) => item.dispose())
      renderer.dispose()
    }
  })

  it('does not treat unused minScalar as gravity in Unity constant mode', async () => {
    const text = prefab.replace(
      '    startColor:',
      '    gravityModifier: {minMaxState: 0, scalar: 0, minScalar: 2}\n    startColor:',
    )
    const { json } = await load(text)
    const emitter = (json.object as any).children[0].children[1]
    expect(emitter.ps.behaviors.some((behavior: any) => behavior.type === 'ForceOverLife')).toBe(
      false,
    )
  })

  it.each([
    { unityType: 0, mode: SubParticleEmitMode.Birth },
    { unityType: 2, mode: SubParticleEmitMode.Death },
  ])(
    'links Unity sub-emitter event $unityType to its target system',
    async ({ unityType, mode }) => {
      const text = prefab.replace(
        '  NoiseModule: {enabled: 0}',
        `  SubModule:\n    enabled: 1\n    subEmitters:\n    - emitter: {fileID: 9007199254740998}\n      type: ${unityType}\n      properties: 0\n      emitProbability: 0.75\n  NoiseModule: {enabled: 0}`,
      )
      const { json, warnings } = await load(text)
      const nodes: any[] = []
      const walk = (node: any) => {
        nodes.push(node)
        for (const child of node.children ?? []) walk(child)
      }
      walk(json.object)
      const owner = nodes.find((node) => node.type === 'ParticleEmitter' && node.name === 'Fire')
      const target = nodes.find(
        (node) => node.type === 'ParticleEmitter' && node.name === 'Inactive child',
      )
      const serialized = owner.ps.behaviors.find(
        (behavior: any) => behavior.type === 'EmitSubParticleSystem',
      )
      expect(serialized).toMatchObject({
        subParticleSystem: target.uuid,
        mode,
        emitProbability: 0.75,
      })
      expect(warnings.join('\n')).not.toContain('SubModule is enabled but not converted')

      const probe = structuredClone(json)
      delete probe.images
      delete probe.textures
      for (const material of probe.materials as Record<string, unknown>[]) delete material.map
      const group = new QuarksLoader().parse(probe)
      const systems: ParticleSystem[] = []
      group.traverse((node) => {
        if ('system' in node) systems.push(node.system as ParticleSystem)
      })
      const behavior = systems
        .flatMap((system) => system.behaviors)
        .find((item) => item.type === 'EmitSubParticleSystem') as EmitSubParticleSystem
      expect(behavior.subParticleSystem?.uuid).toBe(target.uuid)
      expect(behavior.mode).toBe(mode)
      systems.forEach((system) => system.dispose())
    },
  )

  it('warns and skips unsupported Unity sub-emitter events', async () => {
    const text = prefab.replace(
      '  NoiseModule: {enabled: 0}',
      '  SubModule:\n    enabled: 1\n    subEmitters:\n    - emitter: {fileID: 9007199254740998}\n      type: 1\n      properties: 0\n  NoiseModule: {enabled: 0}',
    )
    const { json, warnings } = await load(text)
    const emitter = (json.object as any).children[0].children[1]
    expect(
      emitter.ps.behaviors.some((behavior: any) => behavior.type === 'EmitSubParticleSystem'),
    ).toBe(false)
    expect(warnings.join('\n')).toContain('Sub emitter event 1')
  })

  it('delays burst-only systems without warning, while preserving zero-rate emissions', async () => {
    const text = prefab
      .replace('lengthInSec: 4', 'lengthInSec: 4\n  startDelay: {minMaxState: 0, scalar: 0.25}')
      .replace(
        'rateOverTime: {minMaxState: 0, scalar: 20}',
        'rateOverTime: {minMaxState: 0, scalar: 0}',
      )
      .replace(
        'rateOverDistance: {minMaxState: 0, scalar: 2}',
        'rateOverDistance: {minMaxState: 0, scalar: 0}',
      )
    const { json, warnings } = await load(text)
    const emitter = (json.object as any).children[0].children[1]
    expect(emitter.ps.emissionBursts[0].time).toBe(0.75)
    expect(emitter.ps.emissionOverTime.value).toBe(0)
    expect(warnings.join('\n')).not.toContain('Start delay')
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

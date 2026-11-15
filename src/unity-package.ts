import { parseDocument } from 'yaml'
import * as THREE from 'three'
import {
  Bezier,
  CircleEmitter,
  ColorOverLife,
  ColorRange,
  ConeEmitter,
  ConstantColor,
  ConstantValue,
  DonutEmitter,
  EmitSubParticleSystem,
  EulerGenerator,
  FrameOverLife,
  ForceOverLife,
  Gradient,
  GridEmitter,
  HemisphereEmitter,
  IntervalValue,
  LimitSpeedOverLife,
  ParticleSystem,
  PiecewiseBezier,
  PointEmitter,
  RandomColorBetweenGradient,
  RectangleEmitter,
  RenderMode,
  RotationOverLife,
  Rotation3DOverLife,
  SizeOverLife,
  SubParticleEmitMode,
  SphereEmitter,
  Vector3 as QVector3,
  Vector4 as QVector4,
  Vector3Function,
} from 'three.quarks'
import type { ColorGenerator, FunctionColorGenerator, EmitterShape } from 'three.quarks'
import { parseQuarksDocument } from './document.js'
import type { QuarksDocument } from './document.js'
import { readTextureFile } from './local-files.js'
import { createUnityBuiltinMesh, readUnityMesh } from './unity-mesh.js'

type RecordValue = Record<string, unknown>
type Warn = (message: string) => void
interface UnityObject {
  id: string
  type: string
  value: RecordValue
}
interface Asset {
  path: string
  data: Uint8Array<ArrayBuffer>
  meta?: Uint8Array<ArrayBuffer>
}

export interface UnityPrefabImport {
  json: QuarksDocument
  warnings: string[]
  particleCount: number
}

export interface UnityPackage {
  prefabs: string[]
  convertPrefab(path: string): Promise<UnityPrefabImport>
}

const MB = 1024 * 1024
const decoder = new TextDecoder('utf-8', { fatal: true })
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {}
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const number = (value: unknown, fallback = 0): number => {
  const result = typeof value === 'number' || typeof value === 'bigint' ? Number(value) : NaN
  return Number.isFinite(result) ? result : fallback
}
const enabled = (value: unknown): boolean => number(value) !== 0
const fileId = (value: unknown): string => String(record(value).fileID ?? '0')
const guid = (value: unknown): string => String(record(value).guid ?? '').toLowerCase()

/** Unity packages are gzip/tar archives. Nothing is extracted to disk or fetched. */
export async function readUnityPackage(
  file: File,
  onProgress?: (expandedBytes: number) => void | Promise<void>,
): Promise<UnityPackage> {
  if (!/\.unitypackage$/i.test(file.name) || !file.size || file.size > 128 * MB)
    throw new Error('Choose a .unitypackage file between 1 byte and 128 MB.')
  if (typeof DecompressionStream === 'undefined')
    throw new Error('Unity package import needs a browser with gzip DecompressionStream support.')
  const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader()
  let assets: Map<string, Asset>
  try {
    assets = await readAssets(reader, onProgress)
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw new Error(
      `Could not decompress Unity package: ${error instanceof Error ? error.message : 'invalid gzip'}`,
    )
  } finally {
    reader.releaseLock()
  }
  const prefabs = [...assets.values()]
    .filter((asset) => /\.prefab$/i.test(asset.path))
    .map((asset) => asset.path)
    .sort()
  if (!prefabs.length)
    throw new Error(
      'This package contains no .prefab assets. Export with Include dependencies enabled.',
    )
  return {
    prefabs,
    async convertPrefab(path) {
      const asset = [...assets.values()].find((asset) => asset.path === path)
      if (!asset || !prefabs.includes(path)) throw new Error('Choose a prefab from this package.')
      return convertPrefab(asset, assets)
    },
  }
}

async function readAssets(
  reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>,
  onProgress?: (expandedBytes: number) => void | Promise<void>,
): Promise<Map<string, Asset>> {
  const entries = new Map<string, Uint8Array<ArrayBuffer>>()
  let chunk: Uint8Array<ArrayBuffer> = new Uint8Array(0)
  let offset = 0
  let size = 0
  let count = 0
  let lastProgress = 0
  const next = async () => {
    const { done, value } = await reader.read()
    chunk = value ?? new Uint8Array(0)
    offset = 0
    size += chunk.length
    if (size > 1024 * MB) throw new Error('Expanded Unity package must not exceed 1024 MB.')
    if (onProgress && (done || performance.now() - lastProgress >= 32)) {
      await onProgress(size)
      lastProgress = performance.now()
    }
    return !done
  }
  const read = async (length: number, keep = true): Promise<Uint8Array<ArrayBuffer>> => {
    const bytes = new Uint8Array(keep ? length : 0)
    let written = 0
    while (written < length) {
      if (offset === chunk.length && !(await next()))
        throw new Error('Unity package contains a truncated tar archive.')
      const take = Math.min(length - written, chunk.length - offset)
      if (keep) bytes.set(chunk.subarray(offset, offset + take), written)
      offset += take
      written += take
    }
    return bytes
  }
  while (true) {
    const header = await read(512)
    if (header.every((byte) => byte === 0)) break
    const text = (start: number, length: number) =>
      decoder.decode(header.subarray(start, start + length)).replace(/\0.*$/s, '')
    if (++count > 40000) throw new Error('Unity package has too many archive entries.')
    const octal = text(124, 12).trim()
    const checksum = text(148, 8).trim()
    if (!/^[0-7]+$/.test(octal) || !/^[0-7]+$/.test(checksum))
      throw new Error('Invalid Unity package tar header.')
    const sum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    )
    if (sum !== parseInt(checksum, 8)) throw new Error('Unity package tar checksum mismatch.')
    const length = parseInt(octal, 8)
    if (length > 64 * MB)
      throw new Error('Unity package contains an oversized (64 MB) or truncated asset.')
    const prefix = text(345, 155)
    const name = `${prefix ? `${prefix}/` : ''}${text(0, 100)}`.replace(/^\.\//, '')
    const type = header[156]
    if (type !== 0 && type !== 48 && type !== 53)
      throw new Error(
        'Unsupported Unity package tar entry (links and extended headers are not accepted).',
      )
    const keep = type !== 53 && /^[a-f\d]{32}\/(asset|asset\.meta|pathname)$/i.test(name)
    const data = await read(length, keep)
    if (keep) {
      const key = name.toLowerCase()
      if (entries.has(key)) throw new Error('Unity package contains duplicate asset entries.')
      entries.set(key, data)
    }
    await read((512 - (length % 512)) % 512, false)
  }
  // Drain the gzip stream to verify its trailer and enforce the total limit, including tar padding.
  while (await next()) {}
  const assets = new Map<string, Asset>()
  const paths = new Set<string>()
  for (const [name, data] of entries) {
    if (!name.endsWith('/asset')) continue
    const id = name.slice(0, 32)
    const pathname = entries.get(`${id}/pathname`)
    if (!pathname || pathname.length > 4096)
      throw new Error('Unity asset is missing a valid pathname.')
    // Legacy Asset Store packages append a separate "00" record after the pathname.
    const path = decoder
      .decode(pathname)
      .replace(/\0+$/, '')
      .replace(/\r?\n00$/, '')
      .trim()
    if (
      !path ||
      /[\\\u0000-\u001f]/.test(path) ||
      path.startsWith('/') ||
      path.split('/').includes('..')
    )
      throw new Error('Unsafe Unity asset pathname.')
    if (paths.has(path)) throw new Error(`Duplicate Unity asset path: ${path}`)
    paths.add(path)
    assets.set(id, { path, data, meta: entries.get(`${id}/asset.meta`) })
  }
  return assets
}

function yaml(text: string): RecordValue {
  // GUIDs can be all digits, including leading zeros; they are identifiers, not YAML integers.
  const document = parseDocument(
    text.replace(/\bguid: ([a-f\d]{32})(?=[,}\s]|$)/gi, 'guid: "$1"'),
    { intAsBigInt: true, uniqueKeys: true, schema: 'core' },
  )
  if (document.errors.length) throw new Error(`Invalid Unity YAML: ${document.errors[0]!.message}`)
  return record(document.toJS({ maxAliasCount: 0 }))
}

function objects(asset: Asset): UnityObject[] {
  if (asset.data.length > 16 * MB) throw new Error(`${asset.path}: Unity YAML exceeds 16 MB.`)
  const text = decoder.decode(asset.data)
  if (!/^%YAML|^--- !u!/m.test(text))
    throw new Error(
      `${asset.path}: binary assets are not supported. Re-export with Asset Serialization set to Force Text.`,
    )
  const headers = [...text.matchAll(/^--- !u!\d+ &(-?\d+)(?: stripped)?\s*\r?$/gm)]
  if (!headers.length || headers.length > 20000)
    throw new Error(`${asset.path}: invalid Unity object count.`)
  const ids = new Set<string>()
  return headers.map((header, index) => {
    const id = header[1]!
    if (ids.has(id)) throw new Error(`${asset.path}: duplicate Unity fileID.`)
    ids.add(id)
    const body = yaml(text.slice(header.index! + header[0].length, headers[index + 1]?.index))
    const type = Object.keys(body)[0] ?? ''
    return { id, type, value: record(body[type]) }
  })
}

type Scalar = ConstantValue | IntervalValue | PiecewiseBezier

function scalar(
  value: unknown,
  fallback: number,
  warn: Warn,
  label: string,
  factor = 1,
  offset = 0,
): Scalar {
  if (typeof value === 'number' || typeof value === 'bigint')
    return new ConstantValue(number(value) * factor + offset)
  const data = record(value)
  const scale = number(data.scalar, fallback) * factor
  const mode = number(data.minMaxState)
  if (mode === 0) return new ConstantValue(scale + offset)
  if (mode === 3) {
    const other = number(data.minScalar, fallback) * factor
    return new IntervalValue(Math.min(other, scale) + offset, Math.max(other, scale) + offset)
  }
  if (mode === 2)
    warn(`${label}: random between two curves is not supported; using the maximum curve.`)
  else if (mode !== 1) warn(`${label}: unknown curve mode ${mode}; using the maximum curve.`)
  const keys = array(record(data.maxCurve).m_Curve).map(record)
  if (!keys.length) {
    warn(`${label}: empty animation curve; using its scalar value.`)
    return new ConstantValue(scale + offset)
  }
  if (keys.some((key) => number(key.weightedMode) !== 0))
    warn(`${label}: weighted tangents are approximated with unweighted Hermite tangents.`)
  const points = keys
    .map((key) => ({
      time: number(key.time),
      value: number(key.value) * scale + offset,
      inSlope: Number(key.inSlope ?? 0) * scale,
      outSlope: Number(key.outSlope ?? 0) * scale,
    }))
    .sort((a, b) => a.time - b.time)
  if (
    points.some(
      (point, i) =>
        point.time < 0 || point.time > 1 || (i > 0 && point.time === points[i - 1]!.time),
    )
  )
    throw new Error(`${label}: curve keys must have distinct times in [0, 1].`)
  const curves: [Bezier, number][] = []
  const first = points[0]!
  if (first.time > 0)
    curves.push([new Bezier(first.value, first.value, first.value, first.value), 0])
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!,
      b = points[i + 1]!
    const dt = (b.time - a.time) / 3
    const step = !Number.isFinite(a.outSlope) || !Number.isFinite(b.inSlope)
    curves.push([
      new Bezier(
        a.value,
        step ? a.value : a.value + a.outSlope * dt,
        step ? a.value : b.value - b.inSlope * dt,
        step ? a.value : b.value,
      ),
      a.time,
    ])
  }
  const last = points.at(-1)!
  if (last.time < 1 || !curves.length)
    curves.push([
      new Bezier(last.value, last.value, last.value, last.value),
      last.time === 1 ? 0 : last.time,
    ])
  return new PiecewiseBezier(curves)
}

function rgba(value: unknown): QVector4 {
  const data = record(value)
  return new QVector4(number(data.r, 1), number(data.g, 1), number(data.b, 1), number(data.a, 1))
}

function lifetimeValue(value: Scalar, warn: Warn, label: string): PiecewiseBezier {
  if (value instanceof PiecewiseBezier) return value
  if (value instanceof IntervalValue)
    warn(`${label}: random constants are approximated by their maximum value.`)
  const n = value instanceof ConstantValue ? value.value : value.b
  return new PiecewiseBezier([[new Bezier(n, n, n, n), 0]])
}

function gradient(value: unknown, warn: Warn, label: string): Gradient {
  const data = record(value)
  if (number(data.m_Mode) !== 0)
    warn(`${label}: fixed/perceptual gradient interpolation is approximated as linear.`)
  const colors: [QVector3, number][] = []
  const alphas: [number, number][] = []
  for (let i = 0; i < Math.min(8, number(data.m_NumColorKeys, 2)); i++) {
    const color = rgba(data[`key${i}`])
    colors.push([
      new QVector3(color.x, color.y, color.z),
      number(data[`ctime${i}`], i ? 65535 : 0) / 65535,
    ])
  }
  for (let i = 0; i < Math.min(8, number(data.m_NumAlphaKeys, 2)); i++)
    alphas.push([rgba(data[`key${i}`]).w, number(data[`atime${i}`], i ? 65535 : 0) / 65535])
  if (!colors.length || !alphas.length) throw new Error(`${label}: gradient has no keys.`)
  return new Gradient(
    colors.sort((a, b) => a[1] - b[1]),
    alphas.sort((a, b) => a[1] - b[1]),
  )
}

function color(value: unknown, warn: Warn, label: string): ColorGenerator | FunctionColorGenerator {
  const data = record(value)
  switch (number(data.minMaxState)) {
    case 0:
      return new ConstantColor(rgba(data.maxColor))
    case 1:
      return gradient(data.maxGradient, warn, label)
    case 2:
      return new ColorRange(rgba(data.minColor), rgba(data.maxColor))
    case 3:
      return new RandomColorBetweenGradient(
        gradient(data.minGradient, warn, label),
        gradient(data.maxGradient, warn, label),
      )
    default:
      warn(`${label}: random-color/unknown mode is approximated using the maximum gradient.`)
      return gradient(data.maxGradient, warn, label)
  }
}

function lifetimeColor(value: unknown, warn: Warn): FunctionColorGenerator {
  const generator = color(value, warn, 'Color over Lifetime')
  if (generator.type === 'function') return generator
  const flat = (c: QVector4) => new Gradient([[new QVector3(c.x, c.y, c.z), 0]], [[c.w, 0]])
  if (generator instanceof ColorRange)
    return new RandomColorBetweenGradient(flat(generator.a), flat(generator.b))
  return flat(generator.genColor([], new QVector4()))
}

function shape(value: unknown, warn: Warn, mesh: boolean): EmitterShape {
  const data = record(value)
  if (!enabled(data.enabled)) return new PointEmitter()
  const type = number(data.type)
  const radius =
    typeof data.radius === 'object' ? number(record(data.radius).value, 1) : number(data.radius, 1)
  const thickness = number(data.radiusThickness, [1, 3, 7, 9, 11].includes(type) ? 0 : 1)
  const arc = record(data.arc)
  const params = {
    radius,
    thickness,
    // Reverse the shape's Y axis; the emitter half-turn then reflects only Z.
    arc: (-number(arc.value, number(data.arc, 360)) * Math.PI) / 180,
    mode: number(arc.mode),
    spread: number(arc.spread),
    speed: scalar(arc.speed, 1, warn, 'Shape arc speed'),
  }
  for (const key of ['m_Position', 'm_Rotation', 'm_Scale']) {
    const vector = record(data[key])
    if (
      ['x', 'y', 'z'].some(
        (axis) => number(vector[axis], key === 'm_Scale' ? 1 : 0) !== (key === 'm_Scale' ? 1 : 0),
      )
    )
      warn(`Shape: ${key} is not applied independently of the emitter transform.`)
  }
  if (
    enabled(data.alignToDirection) ||
    number(data.randomDirectionAmount) ||
    number(data.sphericalDirectionAmount) ||
    number(data.randomPositionAmount)
  )
    warn('Shape: direction alignment/randomization and position randomization are not converted.')
  if ([0, 1].includes(type)) return new SphereEmitter(params)
  if ([2, 3].includes(type)) return new HemisphereEmitter(params)
  if ([4, 7, 8, 9].includes(type)) {
    if ([8, 9].includes(type)) warn('Shape: cone volume is approximated by cone base emission.')
    return new ConeEmitter({ ...params, angle: (number(data.angle, 25) * Math.PI) / 180 })
  }
  if ([10, 11].includes(type)) return new CircleEmitter(params)
  if (type === 12 && !mesh) {
    if (number(record(data.radius).mode) || number(record(data.radius).spread))
      warn('Shape: Edge traversal modes and spread are approximated by random emission.')
    // shortcut: native grid quantizes a uniform line to 24 bits; use a custom shape if finer precision is required.
    return new GridEmitter({ width: 2 * radius, height: 0, row: 1, column: 2 ** 24 })
  }
  if (type === 17)
    return new DonutEmitter({ ...params, donutRadius: number(data.donutRadius, 0.2) })
  if ([5, 15, 16, 18].includes(type)) {
    if (type !== 18) warn('Shape: box emission is approximated by a flat rectangle.')
    return new RectangleEmitter({ width: number(data.boxX, 1), height: number(data.boxY, 1) })
  }
  warn(`Shape type ${type} is unsupported; using point emission.`)
  return new PointEmitter()
}

async function convertPrefab(
  asset: Asset,
  assets: ReadonlyMap<string, Asset>,
): Promise<UnityPrefabImport> {
  const docs = objects(asset)
  // shortcut: prefab overrides are not resolved, unpack completely in Unity until override merging is implemented.
  if (
    docs.some(
      (doc) =>
        doc.type === 'PrefabInstance' || fileId(doc.value.m_CorrespondingSourceObject) !== '0',
    )
  )
    throw new Error(
      `${asset.path}: nested prefabs/variants are not yet supported. Unpack the prefab completely in Unity and export again.`,
    )
  const particles = docs.filter((doc) => doc.type === 'ParticleSystem')
  if (!particles.length) throw new Error(`${asset.path}: no Shuriken Particle Systems found.`)
  if (particles.length > 512) throw new Error('A prefab must not exceed 512 Particle Systems.')
  const warnings = new Set<string>()
  const warn: Warn = (message) => warnings.add(message)
  const root = new THREE.Group()
  root.name = asset.path
    .split('/')
    .at(-1)!
    .replace(/\.prefab$/i, '')
  const nodes = new Map<string, THREE.Object3D>()
  const transforms = new Map<string, UnityObject>()
  const renderers = new Map(
    docs
      .filter((doc) => doc.type === 'ParticleSystemRenderer')
      .map((doc) => [fileId(doc.value.m_GameObject), doc.value]),
  )
  const systems: ParticleSystem[] = []
  const systemsByUnityId = new Map<string, ParticleSystem>()
  const materials: THREE.Material[] = []
  const textureUrls = new Map<string, string>()
  const materialCache = new Map<string, THREE.MeshBasicMaterial>()
  const textureCache = new Map<string, THREE.Texture>()
  const shaderNames = new Map<string, string>()
  const meshCache = new Map<string, THREE.BufferGeometry>()

  async function mesh(
    reference: unknown,
    localWarn: Warn,
  ): Promise<THREE.BufferGeometry | undefined> {
    const id = guid(reference)
    const key = `${id}:${fileId(reference)}`
    const cached = meshCache.get(key)
    if (cached) return cached
    const source = assets.get(id)
    try {
      // This GUID denotes Unity's default resources, not an asset-specific exception.
      if (id === '0000000000000000e000000000000000') {
        const geometry = createUnityBuiltinMesh(fileId(reference))
        if (!geometry)
          throw new Error(`Unsupported Unity built-in mesh fileID ${fileId(reference)}.`)
        meshCache.set(key, geometry)
        return geometry
      }
      if (!source) throw new Error(`Mesh ${id || '(built-in/missing)'} is not in the package.`)
      const importer = source.meta ? record(yaml(decoder.decode(source.meta)).ModelImporter) : {}
      const legacy = record(importer.fileIDToRecycleName)
      let name = legacy[fileId(reference)]
      for (const entry of array(importer.internalIDToNameTable).map(record))
        if (String(record(entry.first)['43'] ?? '') === fileId(reference)) name = entry.second
      if (
        name === undefined &&
        (Object.keys(legacy).length || array(importer.internalIDToNameTable).length)
      )
        throw new Error(`Mesh fileID ${fileId(reference)} has no name mapping in ModelImporter.`)
      const settings = { ...record(importer.meshes), ...importer }
      const geometry = await readUnityMesh(
        source.data,
        source.path,
        typeof name === 'string' ? name : undefined,
        number(settings.globalScale, 1),
        enabled(settings.useFileScale ?? settings.useFileUnits ?? 1),
      )
      meshCache.set(key, geometry)
      if (name === undefined)
        localWarn('Mesh fileID/name metadata is unavailable; using the only mesh in the model.')
      // shortcut: axis/alignment overrides are approximated, add axis conversion for non-Y-up assets.
      localWarn(
        'Mesh: model-node transforms, axis-import overrides and renderer alignment are not reproduced exactly; verify orientation in preview.',
      )
      return geometry
    } catch (error) {
      localWarn(
        `${source?.path ?? 'Mesh'}: ${error instanceof Error ? error.message : 'Could not read mesh'} Using a billboard instead.`,
      )
      return undefined
    }
  }

  async function material(reference: unknown): Promise<THREE.MeshBasicMaterial> {
    const id = guid(reference)
    const cached = materialCache.get(id)
    if (cached) return cached
    const source = assets.get(id)
    const result = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    materials.push(result)
    materialCache.set(id, result)
    if (!source) {
      warn(
        `Material ${id || '(built-in/missing)'} is not in the package; using an untextured alpha material.`,
      )
      return result
    }
    const data = objects(source).find((doc) => doc.type === 'Material')?.value
    if (!data) throw new Error(`${source.path}: missing Material object.`)
    result.name = String(data.m_Name ?? source.path)
    const properties = record(data.m_SavedProperties)
    const floats = Object.assign(
      {},
      ...array(properties.m_Floats).map(record),
      ...array(properties.m_Ints).map(record),
    ) as RecordValue
    const colors = Object.assign({}, ...array(properties.m_Colors).map(record)) as RecordValue
    const tint = rgba(colors._BaseColor ?? colors._TintColor ?? colors._Color)
    result.color.setRGB(tint.x, tint.y, tint.z, THREE.LinearSRGBColorSpace)
    result.opacity = tint.w
    if (floats._ZWrite !== undefined) result.depthWrite = enabled(floats._ZWrite)
    if (floats._Cull !== undefined)
      result.side =
        number(floats._Cull) === 0
          ? THREE.DoubleSide
          : number(floats._Cull) === 1
            ? THREE.BackSide
            : THREE.FrontSide
    if (enabled(floats._AlphaClip) || enabled(floats._AlphaTest))
      result.alphaTest = number(floats._Cutoff, 0.5)
    const shaderId = guid(data.m_Shader)
    const shaderAsset = assets.get(shaderId)
    const shader =
      shaderAsset && /\.shader$/i.test(shaderAsset.path)
        ? (/Shader\s+"([^"]+)"/.exec(decoder.decode(shaderAsset.data))?.[1] ?? shaderAsset.path)
        : '(built-in or unavailable shader)'
    shaderNames.set(id, shader)
    if (
      (number(floats._SrcBlend) === 5 && number(floats._DstBlend) === 1) ||
      /additive/i.test(shader)
    )
      result.blending = THREE.AdditiveBlending
    else if (
      floats._DstBlend !== undefined &&
      !(number(floats._SrcBlend) === 5 && number(floats._DstBlend) === 10)
    )
      warn(`${source.path}: blend factors are approximated as normal alpha blending.`)
    warn(
      `${source.path}: Unity shader ${shader} is replaced with a Quarks unlit particle material; custom shader effects are not converted.`,
    )
    const textures = Object.assign({}, ...array(properties.m_TexEnvs).map(record)) as RecordValue
    const main = record(
      guid(record(textures._BaseMap).m_Texture) ? textures._BaseMap : textures._MainTex,
    )
    const textureId = guid(main.m_Texture)
    if (textureId) {
      let texture = textureCache.get(textureId)
      if (!texture) {
        const image = assets.get(textureId)
        if (!image)
          warn(
            `${source.path}: texture ${textureId} is missing. Export with Include dependencies enabled.`,
          )
        else if (!/\.(png|jpe?g|webp|gif)$/i.test(image.path))
          warn(
            `${image.path}: texture format is not supported; convert it to PNG in Unity before exporting.`,
          )
        else {
          const extension = image.path.split('.').at(-1)!.toLowerCase()
          const url = await readTextureFile(
            new File([image.data], image.path.split('/').at(-1)!, {
              type: `image/${extension === 'jpg' ? 'jpeg' : extension}`,
            }),
          )
          texture = new THREE.Texture()
          texture.name = image.path
          texture.colorSpace = THREE.SRGBColorSpace
          textureUrls.set(texture.uuid, url)
          textureCache.set(textureId, texture)
          if (image.meta) {
            const importer = record(yaml(decoder.decode(image.meta)).TextureImporter)
            const settings = record(importer.textureSettings)
            const wrap = (value: unknown) =>
              number(value) === 1
                ? THREE.ClampToEdgeWrapping
                : number(value) === 2
                  ? THREE.MirroredRepeatWrapping
                  : THREE.RepeatWrapping
            texture.wrapS = wrap(settings.wrapU ?? settings.wrapMode)
            texture.wrapT = wrap(settings.wrapV ?? settings.wrapMode)
            if (number(importer.sRGBTexture, 1) === 0) texture.colorSpace = THREE.NoColorSpace
            if (number(settings.filterMode, 1) === 0) {
              texture.magFilter = THREE.NearestFilter
              texture.minFilter = THREE.NearestFilter
            }
          }
        }
      }
      if (texture) {
        result.map = texture.clone()
        textureUrls.set(result.map.uuid, textureUrls.get(texture.uuid)!)
        result.map.repeat.set(number(record(main.m_Scale).x, 1), number(record(main.m_Scale).y, 1))
        result.map.offset.set(number(record(main.m_Offset).x), number(record(main.m_Offset).y))
      }
    }
    for (const [key, value] of Object.entries(textures))
      if (!['_MainTex', '_BaseMap'].includes(key) && guid(record(value).m_Texture))
        warn(`${source.path}: additional texture ${key} is not converted.`)
    return result
  }

  try {
    for (const doc of docs) {
      if (doc.type === 'GameObject') {
        const node = new THREE.Group()
        node.name = String(doc.value.m_Name ?? 'GameObject')
        node.visible = enabled(doc.value.m_IsActive ?? 1)
        node.userData.unityFileID = doc.id
        nodes.set(doc.id, node)
      } else if (doc.type === 'Transform' || doc.type === 'RectTransform') {
        const id = fileId(doc.value.m_GameObject)
        if (transforms.has(id)) throw new Error('Duplicate transform on Unity GameObject.')
        transforms.set(id, doc)
      } else if (
        doc.type === 'MonoBehaviour' ||
        doc.type === 'Animator' ||
        doc.type === 'Animation' ||
        doc.type === 'VisualEffect'
      )
        warn(`${doc.type}: scripts, animation and VFX Graph components are not converted.`)
    }
    const byTransform = new Map([...transforms].map(([id, doc]) => [doc.id, id]))
    for (const [id, node] of nodes) {
      const transform = transforms.get(id)?.value
      if (!transform) throw new Error(`${node.name}: missing Transform.`)
      const p = record(transform.m_LocalPosition),
        q = record(transform.m_LocalRotation),
        s = record(transform.m_LocalScale)
      // Unity is left-handed: reflect Z, and conjugate rotations by that reflection.
      node.position.set(number(p.x), number(p.y), -number(p.z))
      node.quaternion.set(-number(q.x), -number(q.y), number(q.z), number(q.w, 1)).normalize()
      node.scale.set(number(s.x, 1), number(s.y, 1), number(s.z, 1))
      const parentId = fileId(transform.m_Father)
      const seen = new Set([transforms.get(id)!.id])
      let ancestor = parentId
      while (ancestor !== '0') {
        if (seen.has(ancestor) || seen.size > 128)
          throw new Error('Cyclic or excessively deep Unity transform hierarchy.')
        seen.add(ancestor)
        const parentObject = byTransform.get(ancestor)
        if (!parentObject) throw new Error(`${node.name}: missing parent Transform ${ancestor}.`)
        ancestor = fileId(transforms.get(parentObject)!.value.m_Father)
      }
      const parent = parentId === '0' ? root : nodes.get(byTransform.get(parentId)!)
      if (!parent) throw new Error(`${node.name}: missing parent GameObject.`)
      parent.add(node)
    }
    for (const doc of particles) {
      const data = doc.value
      const id = fileId(data.m_GameObject)
      const parent = nodes.get(id)
      if (!parent) throw new Error('ParticleSystem references a missing GameObject.')
      const label = parent.name
      const localWarn: Warn = (message) => warn(`${label}: ${message}`)
      const initial = record(data.InitialModule),
        emission = record(data.EmissionModule),
        startDelay = record(data.startDelay),
        renderer = renderers.get(id) ?? {}
      const delayMode = number(startDelay.minMaxState)
      const delay = delayMode === 0 ? Math.max(0, number(startDelay.scalar)) : 0
      const value = (input: unknown, fallback: number, label: string, factor = 1, offset = 0) =>
        scalar(input, fallback, localWarn, label, factor, offset)
      const mode = number(renderer.m_RenderMode)
      const geometry = mode === 4 ? await mesh(renderer.m_Mesh, localWarn) : undefined
      const renderMode = geometry
        ? RenderMode.Mesh
        : mode === 1
          ? RenderMode.StretchedBillBoard
          : mode === 2
            ? RenderMode.HorizontalBillBoard
            : mode === 3
              ? RenderMode.VerticalBillBoard
              : RenderMode.BillBoard
      if (!renderers.has(id))
        localWarn('Missing ParticleSystemRenderer; using billboard rendering.')
      if (
        mode === 4 &&
        ['m_Mesh1', 'm_Mesh2', 'm_Mesh3'].some((key) => fileId(renderer[key]) !== '0')
      )
        localWarn('Multiple renderer meshes are not supported; only the first mesh is used.')
      if (geometry && ['x', 'y', 'z'].some((axis) => number(record(renderer.m_Pivot)[axis]) !== 0))
        localWarn('Mesh renderer pivot is not converted.')
      const refs = array(renderer.m_Materials)
      if (refs.slice(1).some((reference) => fileId(reference) !== '0'))
        localWarn('Only the first renderer material is used.')
      const mat = await material(refs[0])
      const behaviors = []
      if (enabled(record(data.ColorModule).enabled))
        behaviors.push(
          new ColorOverLife(lifetimeColor(record(data.ColorModule).gradient, localWarn)),
        )
      const size = record(data.SizeModule)
      if (enabled(size.enabled))
        behaviors.push(
          new SizeOverLife(
            enabled(size.separateAxes)
              ? new Vector3Function(
                  value(size.curve, 1, 'Size X'),
                  value(size.y, 1, 'Size Y'),
                  value(size.z, 1, 'Size Z'),
                )
              : lifetimeValue(
                  value(size.curve, 1, 'Size over Lifetime'),
                  localWarn,
                  'Size over Lifetime',
                ),
          ),
        )
      const gravity = record(initial.gravityModifier)
      const gravityMode = number(gravity.minMaxState)
      const hasGravity =
        gravityMode === 3
          ? number(gravity.scalar) !== 0 || number(gravity.minScalar) !== 0
          : [1, 2].includes(gravityMode)
            ? number(gravity.scalar) !== 0 &&
              array(record(gravity.maxCurve).m_Curve).some((key) => number(record(key).value) !== 0)
            : number(initial.gravityModifier) !== 0 || number(gravity.scalar) !== 0
      if (hasGravity)
        behaviors.push(
          new ForceOverLife(
            new ConstantValue(0),
            value(initial.gravityModifier, 0, 'Gravity Modifier', -9.81),
            new ConstantValue(0),
          ),
        )
      if (hasGravity)
        localWarn(
          'Gravity Modifier: using Unity default gravity (-9.81 m/s²); project settings are not in the package.',
        )
      const rotation = record(data.RotationModule)
      if (enabled(rotation.enabled)) {
        if (geometry)
          behaviors.push(
            new Rotation3DOverLife(
              new EulerGenerator(
                enabled(rotation.separateAxes)
                  ? value(rotation.x, 0, 'Rotation X')
                  : new ConstantValue(0),
                enabled(rotation.separateAxes)
                  ? value(rotation.y, 0, 'Rotation Y', -1)
                  : new ConstantValue(0),
                value(rotation.curve, 0, 'Rotation Z', -1),
                'YXZ',
              ),
            ),
          )
        else {
          if (enabled(rotation.separateAxes))
            localWarn('3D rotation over lifetime is approximated by its Z component.')
          behaviors.push(
            new RotationOverLife(value(rotation.curve, 0, 'Rotation over Lifetime', -1)),
          )
        }
      }
      const limit = record(data.ClampVelocityModule)
      if (enabled(limit.enabled)) {
        if (enabled(limit.separateAxis ?? limit.separateAxes))
          localWarn('Limit Velocity: separate-axis limits are not converted.')
        else {
          behaviors.push(
            new LimitSpeedOverLife(
              lifetimeValue(value(limit.magnitude, 1, 'Speed limit'), localWarn, 'Speed limit'),
              Math.max(0, Math.min(1, number(limit.dampen, 1))),
            ),
          )
          localWarn('Limit Velocity: Quarks damping approximates Unity damping; motion may differ.')
        }
        if (
          number(record(limit.drag).scalar) ||
          number(record(limit.drag).minMaxState) ||
          number(limit.drag)
        )
          localWarn('Limit Velocity: drag is not converted.')
      }
      const uv = record(data.UVModule)
      const gridUV = enabled(uv.enabled) && number(uv.mode) === 0
      const tilesX = gridUV ? Math.max(1, number(uv.tilesX, 1)) : 1
      const tilesY = gridUV ? Math.max(1, number(uv.tilesY, 1)) : 1
      if (gridUV) {
        if (
          number(uv.animationType) !== 0 ||
          number(uv.timeMode) !== 0 ||
          number(uv.cycles, 1) !== 1
        )
          localWarn(
            'Texture Sheet: single-row, speed/FPS time and repeated cycles are approximated as whole-sheet lifetime animation.',
          )
        behaviors.push(
          new FrameOverLife(
            lifetimeValue(
              value(uv.frameOverTime, 1, 'Frame over Time', tilesX * tilesY),
              localWarn,
              'Frame over Time',
            ),
          ),
        )
      } else if (enabled(uv.enabled))
        localWarn('Sprite-based texture sheet animation is not converted.')
      for (const [key, module] of Object.entries(data))
        if (
          key.endsWith('Module') &&
          ![
            'InitialModule',
            'ShapeModule',
            'EmissionModule',
            'ColorModule',
            'SizeModule',
            'RotationModule',
            'ClampVelocityModule',
            'UVModule',
            'SubModule',
          ].includes(key) &&
          enabled(record(module).enabled)
        )
          localWarn(`${key} is enabled but not converted.`)
      if (number(data.simulationSpeed, 1) !== 1) localWarn('Simulation speed is not converted.')
      const simulationSpace = number(data.moveWithTransform)
      if (![0, 1, 2].includes(simulationSpace))
        localWarn(`Unknown simulation space ${simulationSpace}; using local space.`)
      if (simulationSpace === 2 || fileId(data.moveWithCustomTransform) !== '0')
        localWarn('Custom simulation-space transform is not converted.')
      if (delayMode !== 0) localWarn('Random/curve start delay is not converted.')
      if (
        delay > 0 &&
        enabled(emission.enabled) &&
        ['rateOverTime', 'rateOverDistance'].some((key) => {
          const input =
            key === 'rateOverTime' ? (emission.rateOverTime ?? emission.rate) : emission[key]
          if (typeof input === 'number') return input !== 0
          const rate = record(input)
          return number(rate.minMaxState) !== 0 || number(rate.scalar) !== 0
        })
      )
        localWarn('Start delay: continuous emission starts immediately; only bursts are delayed.')
      if (!geometry && enabled(initial.rotation3D))
        localWarn('3D start rotation is approximated by its Z component.')
      if (enabled(initial.randomizeRotationDirection))
        localWarn('Randomized rotation direction is not converted.')
      localWarn(
        'Unity maxParticles, culling, scaling modes and exact random seeds are not reproduced by Quarks.',
      )
      const activeEmission = enabled(emission.enabled)
      const system = new ParticleSystem({
        material: mat,
        instancingGeometry: geometry,
        autoDestroy: false,
        duration: number(data.lengthInSec, 5),
        looping: enabled(data.looping),
        prewarm: enabled(data.prewarm),
        worldSpace: simulationSpace === 1,
        shape: shape(data.ShapeModule, localWarn, !!geometry),
        startLife: value(initial.startLifetime, 5, 'Start Lifetime'),
        startSpeed: value(initial.startSpeed, 5, 'Start Speed'),
        startSize: enabled(initial.size3D)
          ? new Vector3Function(
              value(initial.startSize, 1, 'Start Size X'),
              value(initial.startSizeY, 1, 'Start Size Y'),
              value(initial.startSizeZ, 1, 'Start Size Z'),
            )
          : value(initial.startSize, 1, 'Start Size'),
        // Preserve mesh orientation when replacing the reflected emitter with an X half-turn.
        startRotation: geometry
          ? enabled(initial.rotation3D)
            ? new EulerGenerator(
                value(initial.startRotationX, 0, 'Start Rotation X', -1),
                value(initial.startRotationY, 0, 'Start Rotation Y'),
                value(initial.startRotation, 0, 'Start Rotation Z', -1, Math.PI),
                'YXZ',
              )
            : new EulerGenerator(
                new ConstantValue(0),
                value(initial.startRotation, 0, 'Start Rotation'),
                new ConstantValue(Math.PI),
                'YXZ',
              )
          : value(initial.startRotation, 0, 'Start Rotation', -1),
        startColor: color(initial.startColor, localWarn, 'Start Color'),
        emissionOverTime: activeEmission
          ? value(emission.rateOverTime ?? emission.rate, 10, 'Emission rate')
          : new ConstantValue(0),
        emissionOverDistance: activeEmission
          ? value(emission.rateOverDistance, 0, 'Distance emission')
          : new ConstantValue(0),
        emissionBursts: activeEmission
          ? array(emission.m_Bursts).map((burst) => {
              const b = record(burst)
              return {
                time: number(b.time) + delay,
                count: b.countCurve
                  ? value(b.countCurve, 1, 'Burst count')
                  : new IntervalValue(number(b.minCount, 1), number(b.maxCount, 1)),
                cycle: number(b.cycleCount, 1),
                interval: number(b.repeatInterval, 1),
                probability: number(b.probability, 1),
              }
            })
          : [],
        renderMode,
        renderOrder: number(renderer.m_SortingOrder),
        rendererEmitterSettings:
          mode === 1
            ? {
                speedFactor: number(renderer.m_VelocityScale),
                lengthFactor: number(renderer.m_LengthScale, 2),
              }
            : {},
        uTileCount: tilesX,
        vTileCount: tilesY,
        startTileIndex: (() => {
          const start = gridUV
            ? value(uv.startFrame, 0, 'Start Frame', tilesX * tilesY)
            : new ConstantValue(0)
          if (!(start instanceof PiecewiseBezier)) return start
          localWarn('Texture Sheet: start-frame curve is sampled at time zero.')
          return new ConstantValue(start.genValue([], 0))
        })(),
        behaviors,
      })
      systems.push(system)
      systemsByUnityId.set(doc.id, system)
      system.emitter.name = label
      system.emitter.visible = mode !== 5 && enabled(renderer.m_Enabled ?? 1)
      for (let ancestor: THREE.Object3D | null = parent; ancestor; ancestor = ancestor.parent)
        system.emitter.visible &&= ancestor.visible
      // Negative emitter scale makes Quarks world-space positions and velocities disagree.
      system.emitter.rotation.x = Math.PI
      // Unity Edge emits along +Y, while the native grid emits along +Z.
      if (
        !geometry &&
        enabled(record(data.ShapeModule).enabled) &&
        number(record(data.ShapeModule).type) === 12
      )
        system.emitter.rotation.x = -Math.PI / 2
      parent.add(system.emitter)
    }
    for (const doc of particles) {
      const module = record(doc.value.SubModule)
      if (!enabled(module.enabled)) continue
      const owner = systemsByUnityId.get(doc.id)!
      const label = owner.emitter.name
      const localWarn: Warn = (message) => warn(`${label}: ${message}`)
      for (const subEmitter of array(module.subEmitters).map(record)) {
        const target = systemsByUnityId.get(fileId(subEmitter.emitter))
        if (!target) {
          localWarn(
            `Sub emitter ${fileId(subEmitter.emitter)} is not a Particle System in this prefab.`,
          )
          continue
        }
        const event = number(subEmitter.type, -1)
        const mode =
          event === 0
            ? SubParticleEmitMode.Birth
            : event === 2
              ? SubParticleEmitMode.Death
              : undefined
        if (mode === undefined) {
          localWarn(`Sub emitter event ${event} (collision/trigger/manual) is not supported.`)
          continue
        }
        if (enabled(subEmitter.properties))
          localWarn('Sub emitter inherited particle properties are not converted.')
        owner.addBehavior(
          new EmitSubParticleSystem(
            owner,
            false,
            target.emitter,
            mode,
            Math.max(0, Math.min(1, number(subEmitter.emitProbability, 1))),
          ),
        )
      }
    }
    root.userData.unityImport = {
      source: asset.path,
      warnings: [...warnings],
      shaders: Object.fromEntries(shaderNames),
    }
    root.updateMatrixWorld(true)
    const json = root.toJSON() as unknown as QuarksDocument
    const textureJSON = (json.textures ?? []) as RecordValue[]
    // Serialize embedded sources directly: avoid canvas re-encoding and asynchronous image loads.
    json.images = [
      ...new Map(
        textureJSON.map((texture) => {
          const url = textureUrls.get(String(texture.uuid))
          if (!url) throw new Error('Missing embedded Unity texture.')
          return [String(texture.image), { uuid: texture.image, url }] as const
        }),
      ).values(),
    ]
    for (const item of (json.materials ?? []) as RecordValue[]) {
      const original = materials.find((material) => material.uuid === item.uuid)
      if (original) {
        item.blending = original.blending
        item.transparent = original.transparent
        item.depthWrite = original.depthWrite
      }
    }
    if (new Blob([JSON.stringify(json)]).size > 64 * MB)
      throw new Error(
        'Converted JSON exceeds 64 MB. Export a smaller prefab or reduce texture sizes.',
      )
    return {
      json: parseQuarksDocument(json),
      warnings: [...warnings],
      particleCount: systems.length,
    }
  } finally {
    for (const system of systems) system.dispose()
    for (const material of materials) {
      if (material instanceof THREE.MeshBasicMaterial) material.map?.dispose()
      material.dispose()
    }
    for (const texture of textureCache.values()) texture.dispose()
    for (const geometry of meshCache.values()) geometry.dispose()
  }
}

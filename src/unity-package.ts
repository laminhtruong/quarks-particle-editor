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
  Noise,
  ParticleSystem,
  PiecewiseBezier,
  PointEmitter,
  RandomColorBetweenGradient,
  RenderMode,
  RotationOverLife,
  Rotation3DOverLife,
  RotationBySpeed,
  SizeOverLife,
  WidthOverLength,
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
import { ColorOverTrail, RandomColorFromGradient } from './unity-behaviors.js'
import { createUnityBuiltinMesh, readUnityMesh } from './unity-mesh.js'

type RecordValue = Record<string, unknown>
type Warn = (message: string) => void
interface UnityObject {
  id: string
  type: string
  value: RecordValue
  /** A placeholder for an object supplied by a prefab instance (`--- !u!N &id stripped`). */
  stripped?: boolean
}
/** A Unity asset: its project path, file bytes and `.meta` bytes. */
export interface UnityAsset {
  path: string
  data: Uint8Array<ArrayBuffer>
  meta?: Uint8Array<ArrayBuffer>
}
type Asset = UnityAsset

export interface UnityConvertOptions {
  /**
   * Convert only this Transform and its descendants (a fileID in the resolved prefab, using Unity's
   * prefab-instance IDs). The subtree root keeps its rotation and scale but not its position or
   * active state: the caller places, shows and hides it, as a UI layout does with a UIParticle.
   */
  root?: string
  /** Decodes a raster texture into a data URL; defaults to the browser image decoder. */
  readTexture?: (data: Uint8Array<ArrayBuffer>, path: string, type: string) => Promise<string>
  /**
   * World units per canvas unit of the root UI canvas. With UIParticle's "UIParticle" scaling
   * mode, its Particle Systems inherit the canvas scale but absolute trail widths do not, so a
   * trail's width relative to its particles depends on the canvas the effect is shown in.
   */
  canvasWorldScale?: number
  /** The project's Physics gravity along Y (Project Settings > Physics); defaults to -9.81. */
  gravity?: number
}

export interface UnityPrefabImport {
  json: QuarksDocument
  warnings: string[]
  particleCount: number
}

export interface UnityPackage {
  prefabs: string[]
  convertPrefab(path: string, options?: UnityConvertOptions): Promise<UnityPrefabImport>
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
    async convertPrefab(path, options) {
      const asset = [...assets.values()].find((asset) => asset.path === path)
      if (!asset || !prefabs.includes(path)) throw new Error('Choose a prefab from this package.')
      return convertUnityPrefab(asset, assets, options)
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

/**
 * Unity writes the closing quote of a multi-line prefab override value at column one, which YAML
 * rejects as under-indented; indent it as a continuation line of that value.
 */
const indentQuoteContinuations = (text: string) =>
  text.replace(
    /^([ \t]*(?:-[ \t]+)?value:[ \t]*)'((?:[^'\r\n]|'')*)(\r?\n(?:[ \t]*\r?\n)*)'(?=\r?$)/gm,
    (_, prefix: string, value: string, blankLines: string) => {
      const indentation = /^[ \t]*/.exec(prefix)![0]
      const continuation =
        indentation + (prefix.slice(indentation.length).startsWith('-') ? '    ' : '  ')
      return `${prefix}'${value}${blankLines}${continuation}'`
    },
  )

function yaml(text: string): RecordValue {
  // GUIDs can be all digits, including leading zeros; they are identifiers, not YAML integers.
  const parse = (source: string) =>
    parseDocument(source.replace(/\bguid: ([a-f\d]{32})(?=[,}\s]|$)/gi, 'guid: "$1"'), {
      intAsBigInt: true,
      uniqueKeys: true,
      schema: 'core',
    })
  let document = parse(text)
  if (document.errors.some((error) => error.message.includes("Missing closing 'quote"))) {
    const repaired = indentQuoteContinuations(text)
    if (repaired !== text) document = parse(repaired)
  }
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
  const headers = [...text.matchAll(/^--- !u!\d+ &(-?\d+)( stripped)?\s*\r?$/gm)]
  if (!headers.length || headers.length > 20000)
    throw new Error(`${asset.path}: invalid Unity object count.`)
  const ids = new Set<string>()
  return headers.map((header, index) => {
    const id = header[1]!
    if (ids.has(id)) throw new Error(`${asset.path}: duplicate Unity fileID.`)
    ids.add(id)
    const body = yaml(text.slice(header.index! + header[0].length, headers[index + 1]?.index))
    const type = Object.keys(body)[0] ?? ''
    return { id, type, value: record(body[type]), ...(header[2] ? { stripped: true } : {}) }
  })
}

/**
 * A UIParticle (ParticleEffectForUGUI) component, recognized by its serialized fields: it
 * renders the listed Particle Systems on a UI canvas with an extra presentation scale.
 */
const isUIParticle = (doc: UnityObject) =>
  doc.type === 'MonoBehaviour' &&
  Array.isArray(doc.value.m_Particles) &&
  (doc.value.m_Scale3D !== undefined || doc.value.m_Scale !== undefined)

const FILE_ID_MASK = (1n << 63n) - 1n
/** Unity's fileID for an object of a prefab instance: (instance ^ source object) & 0x7FFF…FFFF. */
const instanceObjectId = (instance: string, source: string) =>
  String((BigInt(instance) ^ BigInt(source)) & FILE_ID_MASK)

/** Rewrites local references ({fileID} without a GUID) inside a serialized object tree. */
function remapReferences(value: unknown, map: (id: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => remapReferences(item, map))
  if (value === null || typeof value !== 'object') return value
  const data = value as RecordValue
  const result: RecordValue = {}
  for (const [key, item] of Object.entries(data)) result[key] = remapReferences(item, map)
  if ('fileID' in data && !guid(data) && fileId(data) !== '0') result.fileID = map(fileId(data))
  return result
}

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

/**
 * Applies one prefab modification. Property paths are Unity SerializedProperty paths: fields
 * separated by dots, with `Array.size` and `Array.data[i]` addressing serialized arrays.
 */
function applyModification(target: RecordValue, path: string, apply: (old: unknown) => unknown) {
  const parts = path.split('.')
  if (parts.some((part) => UNSAFE_KEYS.has(part))) return false
  let container: RecordValue | unknown[] = target
  let key: string | number = parts[0]!
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!
    if (part !== 'Array') {
      const child = record(container)[key as string] ?? (container as unknown[])[key as number]
      if (!child || typeof child !== 'object') {
        const created = {}
        ;(container as RecordValue)[key as string] = created
        container = created
      } else container = child as RecordValue
      key = part
      continue
    }
    const element = parts[++i] ?? ''
    let list = (container as RecordValue)[key as string]
    if (!Array.isArray(list)) (container as RecordValue)[key as string] = list = []
    const items = list as unknown[]
    if (element === 'size') {
      if (i !== parts.length - 1) return false
      const size = Math.floor(number(apply(items.length)))
      if (!(size >= 0 && size <= 100000)) throw new Error('Prefab override array size is invalid.')
      while (items.length > size) items.pop()
      while (items.length < size)
        items.push(items.length ? structuredClone(items[items.length - 1]) : {})
      return true
    }
    const index = /^data\[(\d+)\]$/.exec(element)?.[1]
    if (index === undefined || Number(index) >= 100000) return false
    while (items.length <= Number(index)) items.push({})
    container = items
    key = Number(index)
  }
  const holder = container as RecordValue & unknown[]
  holder[key as never] = apply(holder[key as never]) as never
  return true
}

/**
 * The effective objects of a prefab, with prefab instances (variants and nested prefabs) merged
 * from their source prefabs: source objects receive Unity's instance fileIDs, property
 * modifications, removed components/GameObjects and the instance's transform parent.
 */
function resolvePrefabObjects(
  asset: Asset,
  assets: ReadonlyMap<string, Asset>,
  warn: Warn,
  stack: readonly string[] = [],
): UnityObject[] {
  if (stack.length > 16) throw new Error(`${asset.path}: prefab nesting is too deep or cyclic.`)
  const docs = objects(asset)
  const instances = docs.filter((doc) => doc.type === 'PrefabInstance')
  if (!instances.length) return docs
  const result = docs.filter((doc) => !doc.stripped && doc.type !== 'PrefabInstance')
  const ids = new Set(result.map((doc) => doc.id))
  for (const instance of instances) {
    const sourceGuid = guid(instance.value.m_SourcePrefab)
    const source = assets.get(sourceGuid)
    if (!source || !/\.prefab$/i.test(source.path))
      throw new Error(
        `${asset.path}: source prefab ${sourceGuid || '(missing)'} of a prefab variant/nested prefab is not in the package. Export with Include dependencies enabled.`,
      )
    if (stack.includes(sourceGuid)) throw new Error(`${asset.path}: cyclic prefab reference.`)
    const modification = record(instance.value.m_Modification)
    const removed = new Set(
      array(modification.m_RemovedComponents)
        .map(record)
        .filter((target) => guid(target) === sourceGuid)
        .map((target) => fileId(target)),
    )
    const removedObjects = new Set(
      array(modification.m_RemovedGameObjects)
        .map(record)
        .filter((target) => guid(target) === sourceGuid)
        .map((target) => fileId(target)),
    )
    let sourceDocs = resolvePrefabObjects(source, assets, warn, [...stack, sourceGuid])
    if (removedObjects.size) {
      // Removing a GameObject removes its components and its whole child hierarchy.
      const owner = new Map(
        sourceDocs
          .filter((doc) => doc.type === 'Transform' || doc.type === 'RectTransform')
          .map((doc) => [doc.id, fileId(doc.value.m_GameObject)]),
      )
      let grew = true
      while (grew) {
        grew = false
        for (const doc of sourceDocs) {
          const parentObject = owner.get(fileId(doc.value.m_Father))
          const object = owner.get(doc.id)
          if (
            object &&
            parentObject &&
            removedObjects.has(parentObject) &&
            !removedObjects.has(object)
          ) {
            removedObjects.add(object)
            grew = true
          }
        }
      }
    }
    sourceDocs = sourceDocs.filter(
      (doc) =>
        !removed.has(doc.id) &&
        !removedObjects.has(doc.id) &&
        !removedObjects.has(fileId(doc.value.m_GameObject)),
    )
    const map = (id: string) => instanceObjectId(instance.id, id)
    const merged = new Map(
      sourceDocs.map((doc) => [
        map(doc.id),
        { id: map(doc.id), type: doc.type, value: remapReferences(doc.value, map) as RecordValue },
      ]),
    )
    for (const change of array(modification.m_Modifications).map(record)) {
      const target = record(change.target)
      const doc = guid(target) === sourceGuid ? merged.get(map(fileId(target))) : undefined
      const path = String(change.propertyPath ?? '')
      if (!doc || !path) continue
      const reference = record(change.objectReference)
      const applied = applyModification(doc.value, path, (old) =>
        // Object reference properties are overridden by objectReference, including None.
        (old !== null && typeof old === 'object' && 'fileID' in (old as RecordValue)) ||
        fileId(reference) !== '0'
          ? { ...reference }
          : (change.value ?? (typeof old === 'string' ? '' : old)),
      )
      if (!applied) warn(`${asset.path}: prefab override ${path} is not converted.`)
    }
    // The instance root is parented to m_TransformParent (fileID 0 for a variant's root).
    const parent = record(modification.m_TransformParent)
    for (const doc of merged.values())
      if (
        (doc.type === 'Transform' || doc.type === 'RectTransform') &&
        fileId(doc.value.m_Father) === '0'
      )
        doc.value.m_Father = { fileID: fileId(parent) }
    for (const doc of merged.values()) {
      if (ids.has(doc.id))
        throw new Error(`${asset.path}: duplicate Unity fileID after merging prefab instances.`)
      ids.add(doc.id)
      result.push(doc)
    }
  }
  if (result.length > 20000) throw new Error(`${asset.path}: invalid Unity object count.`)
  return result
}

type Scalar = ConstantValue | IntervalValue | PiecewiseBezier

/** A cubic Bezier segment over source time [s, e]; control points are per-segment values. */
interface Piece {
  p: number[]
  s: number
  e: number
}

function splitBezier(p: readonly number[], u: number): [number[], number[]] {
  const [a, b, c, d] = p as [number, number, number, number]
  const ab = a + (b - a) * u,
    bc = b + (c - b) * u,
    cd = c + (d - c) * u
  const abc = ab + (bc - ab) * u,
    bcd = bc + (cd - bc) * u
  const m = abc + (bcd - abc) * u
  return [
    [a, ab, abc, m],
    [m, bcd, cd, d],
  ]
}

function pieces(curve: PiecewiseBezier): Piece[] {
  const functions = curve.functions
  return functions.map(([bezier, s], i) => ({ p: [...bezier.p], s, e: functions[i + 1]?.[1] ?? 1 }))
}

/** Restricts pieces to source time [t0, t1], subdividing Bezier segments exactly. */
function windowPieces(source: Piece[], t0: number, t1: number): Piece[] {
  const result: Piece[] = []
  for (const piece of source) {
    const s = Math.max(piece.s, t0),
      e = Math.min(piece.e, t1)
    if (!(e > s)) continue
    const width = piece.e - piece.s
    const u0 = (s - piece.s) / width,
      u1 = (e - piece.s) / width
    let p = u0 > 0 ? splitBezier(piece.p, u0)[1] : piece.p
    if (u1 < 1) p = splitBezier(p, (u1 - u0) / (1 - u0))[0]
    result.push({ p, s, e })
  }
  return result
}

const flatPiece = (value: number, s: number, e: number): Piece => ({
  p: [value, value, value, value],
  s,
  e,
})

function toCurve(source: Piece[]): PiecewiseBezier {
  const sorted = source.filter((piece) => piece.e - piece.s > 1e-9).sort((a, b) => a.s - b.s)
  if (!sorted.length) throw new Error('Curve has no segments.')
  if (sorted[0]!.s > 0) sorted.unshift(flatPiece(sorted[0]!.p[0]!, 0, sorted[0]!.s))
  return new PiecewiseBezier(
    sorted.map(({ p, s }) => [new Bezier(p[0]!, p[1]!, p[2]!, p[3]!), s] as [Bezier, number]),
  )
}

/** Unity texture-sheet cycles: G(t) = F(fract(t * cycles)). */
function repeatCurve(curve: PiecewiseBezier, cycles: number): PiecewiseBezier {
  if (cycles === 1) return curve
  const source = pieces(curve)
  const result: Piece[] = []
  for (let k = 0; k < cycles; k++)
    for (const piece of windowPieces(source, 0, Math.min(1, cycles - k)))
      result.push({ p: piece.p, s: (piece.s + k) / cycles, e: (piece.e + k) / cycles })
  return toCurve(result)
}

/** Non-looping start delay: the system's normalized time [0, 1] becomes [start, 1]. */
function delayCurve(curve: PiecewiseBezier, start: number, before?: number): PiecewiseBezier {
  const mapped = pieces(curve).map((piece) => ({
    p: piece.p,
    s: start + (1 - start) * piece.s,
    e: start + (1 - start) * piece.e,
  }))
  return toCurve([flatPiece(before ?? mapped[0]!.p[0]!, 0, start), ...mapped])
}

/** Looping start delay keeps the phase: G(t) = F((t - phase) mod 1). */
function phaseCurve(curve: PiecewiseBezier, phase: number): PiecewiseBezier {
  if (!phase) return curve
  const source = pieces(curve)
  return toCurve([
    ...windowPieces(source, 1 - phase, 1).map((piece) => ({
      p: piece.p,
      s: piece.s - (1 - phase),
      e: piece.e - (1 - phase),
    })),
    ...windowPieces(source, 0, 1 - phase).map((piece) => ({
      p: piece.p,
      s: piece.s + phase,
      e: piece.e + phase,
    })),
  ])
}

/** The constant value of a Unity curve whose keys are all equal with zero tangents. */
function flatCurveValue(value: unknown): number | undefined {
  const keys = array(record(value).m_Curve).map(record)
  if (!keys.length) return undefined
  const first = number(keys[0]!.value)
  return keys.every(
    (key) =>
      number(key.value) === first &&
      Number(key.inSlope ?? 0) === 0 &&
      Number(key.outSlope ?? 0) === 0,
  )
    ? first
    : undefined
}

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
  if (mode === 2) {
    // Unity lerps per particle between both curves; two flat curves are exactly a random constant.
    const min = flatCurveValue(data.minCurve),
      max = flatCurveValue(data.maxCurve)
    if (min !== undefined && max !== undefined) {
      const a = min * scale + offset,
        b = max * scale + offset
      return a === b ? new ConstantValue(a) : new IntervalValue(Math.min(a, b), Math.max(a, b))
    }
    warn(`${label}: random between two curves is not supported; using the maximum curve.`)
  } else if (mode !== 1) warn(`${label}: unknown curve mode ${mode}; using the maximum curve.`)
  const maxCurve = record(data.maxCurve)
  const keys = array(maxCurve.m_Curve).map(record)
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
  if (points.some((point, i) => i > 0 && point.time === points[i - 1]!.time))
    throw new Error(`${label}: curve keys must have distinct times.`)
  const first = points[0]!,
    last = points.at(-1)!
  // Unity's internal wrap mode 2 clamps outside the key range; other modes repeat the curve.
  if (
    (first.time > 0 && number(maxCurve.m_PreInfinity, 2) !== 2) ||
    (last.time < 1 && number(maxCurve.m_PostInfinity, 2) !== 2)
  )
    warn(`${label}: curve loop/ping-pong wrap modes are approximated by clamping.`)
  const segments: Piece[] = [flatPiece(first.value, Math.min(0, first.time - 1), first.time)]
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!,
      b = points[i + 1]!
    const dt = (b.time - a.time) / 3
    // Unity evaluates an infinite (constant) tangent as holding the left key.
    const step = !Number.isFinite(a.outSlope) || !Number.isFinite(b.inSlope)
    segments.push({
      p: step
        ? [a.value, a.value, a.value, a.value]
        : [a.value, a.value + a.outSlope * dt, b.value - b.inSlope * dt, b.value],
      s: a.time,
      e: b.time,
    })
  }
  segments.push(flatPiece(last.value, last.time, Math.max(1, last.time + 1)))
  // Keys may lie outside [0, 1]; only the evaluated lifetime/duration range is kept.
  return toCurve(windowPieces(segments, 0, 1))
}

function rgba(value: unknown): QVector4 {
  const data = record(value)
  return new QVector4(number(data.r, 1), number(data.g, 1), number(data.b, 1), number(data.a, 1))
}

const scalarMid = (value: ConstantValue | IntervalValue) =>
  value instanceof ConstantValue ? value.value : (value.a + value.b) / 2

const addScalar = (value: ConstantValue | IntervalValue, offset: number) =>
  value instanceof ConstantValue
    ? new ConstantValue(value.value + offset)
    : new IntervalValue(value.a + offset, value.b + offset)

/** Unity Texture Sheet Animation in Grid mode as a Quarks tile index and optional FrameOverLife. */
function textureSheet(
  uv: RecordValue,
  startLifetime: Scalar,
  warn: Warn,
): {
  tilesX: number
  tilesY: number
  startTileIndex: ConstantValue | IntervalValue
  frame?: PiecewiseBezier
} {
  if (!enabled(uv.enabled) || number(uv.mode) !== 0) {
    if (enabled(uv.enabled)) warn('Sprite-based texture sheet animation is not converted.')
    return { tilesX: 1, tilesY: 1, startTileIndex: new ConstantValue(0) }
  }
  const tilesX = Math.max(1, Math.floor(number(uv.tilesX, 1)))
  const tilesY = Math.max(1, Math.floor(number(uv.tilesY, 1)))
  const singleRow = number(uv.animationType) === 1
  const frames = singleRow ? tilesX : tilesX * tilesY
  let rowOffset = 0
  if (singleRow) {
    // Unity 2019+ uses rowMode (Custom, Random, MeshIndex); older files use randomRow.
    const rowMode =
      uv.rowMode !== undefined ? number(uv.rowMode) : enabled(uv.randomRow ?? 1) ? 1 : 0
    if (rowMode === 0)
      rowOffset = Math.min(tilesY - 1, Math.max(0, Math.floor(number(uv.rowIndex)))) * tilesX
    else warn('Texture Sheet: random/mesh-index row selection is approximated by the first row.')
  }
  let start: Scalar = scalar(uv.startFrame, 0, warn, 'Start Frame', frames, rowOffset)
  if (start instanceof PiecewiseBezier) {
    warn('Texture Sheet: start-frame curve is sampled at time zero.')
    start = new ConstantValue(start.genValue([], 0))
  }
  const timeMode = number(uv.timeMode)
  let cycles = number(uv.cycles, 1) > 0 ? number(uv.cycles, 1) : 1
  let frame: Scalar
  if (timeMode === 2) {
    // FPS mode advances one whole animation per frames / fps seconds of particle age.
    const life =
      startLifetime instanceof ConstantValue
        ? startLifetime.value
        : startLifetime instanceof IntervalValue
          ? startLifetime.b
          : Math.max(...startLifetime.functions.flatMap(([curve]) => curve.p))
    if (!(startLifetime instanceof ConstantValue))
      warn('Texture Sheet: FPS timing with variable lifetime uses the maximum start lifetime.')
    cycles = (Math.max(0, life) * Math.max(0, number(uv.fps, 30))) / frames || 1
    const end = frames * 0.9999
    frame = new PiecewiseBezier([[new Bezier(0, end / 3, (2 * end) / 3, end), 0]])
  } else {
    if (timeMode === 1)
      warn('Texture Sheet: speed-range timing is approximated by lifetime timing.')
    frame = scalar(uv.frameOverTime, 1, warn, 'Frame over Time', frames)
  }
  if (cycles > 1000) {
    warn('Texture Sheet: more than 1000 cycles per lifetime are limited to 1000.')
    cycles = 1000
  }
  if (!(frame instanceof PiecewiseBezier)) {
    // A per-particle constant frame is a start tile; FrameOverLife ignores non-curve values.
    if (start instanceof ConstantValue)
      return { tilesX, tilesY, startTileIndex: addScalar(frame, start.value) }
    if (frame instanceof IntervalValue)
      warn('Texture Sheet: random start frame plus random frame uses the start-frame midpoint.')
    return { tilesX, tilesY, startTileIndex: addScalar(start, scalarMid(frame)) }
  }
  if (start instanceof IntervalValue)
    warn('Texture Sheet: random start frame with animated frames uses the start-frame midpoint.')
  const animated = offsetFrames(repeatCurve(frame, cycles), scalarMid(start))
  return {
    tilesX,
    tilesY,
    startTileIndex: new ConstantValue(animated.genValue([], 0)),
    frame: animated,
  }
}

function offsetFrames(value: PiecewiseBezier, offset: number): PiecewiseBezier {
  return new PiecewiseBezier(
    value.functions.map(([curve, start]) => {
      const [p0, p1, p2, p3] = curve.p
      return [new Bezier(p0! + offset, p1! + offset, p2! + offset, p3! + offset), start]
    }),
  )
}

function gradient(value: unknown, warn: Warn, label: string): Gradient {
  const data = record(value)
  const mode = number(data.m_Mode)
  if (mode === 2) warn(`${label}: perceptual gradient interpolation is approximated as linear.`)
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
  // Unity's Fixed mode holds each key's value from the previous key's time up to its own time.
  const keys = <T>(list: [T, number][]) => {
    const sorted = list.sort((a, b) => a[1] - b[1])
    if (mode !== 1) return sorted
    return sorted.flatMap((key, i): [T, number][] =>
      i ? [[key[0], Math.min(key[1], sorted[i - 1]![1] + 1e-4)], key] : [key],
    )
  }
  return new Gradient(keys(colors), keys(alphas))
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

/**
 * Unity removes the dampen fraction of a particle's excess speed per 1/30 s step (measured against
 * Unity footage); Quarks removes excess × dampen × 20 per second. Equal decay rates give
 * 20·q = −30·ln(1 − d). Quarks' per-frame factor 1 − 20·q·dt must stay positive at 60 FPS.
 */
const quarksDampen = (dampen: number) =>
  dampen >= 1 ? 3 : Math.min(3, -1.5 * Math.log(1 - dampen))

// Uniform random samples on a native grid; each axis is quantized to this many cells.
const GRID_CELLS = 2 ** 12

function shape(value: unknown, warn: Warn, mesh: boolean): EmitterShape {
  const data = record(value)
  if (!enabled(data.enabled)) return new PointEmitter()
  const type = number(data.type)
  // Shape scale (Unity 2017+) scales spawn positions; it is baked into the native dimensions.
  const scaleData = record(data.m_Scale)
  const [sx, sy, sz] = ['x', 'y', 'z'].map((axis) => Math.abs(number(scaleData[axis], 1))) as [
    number,
    number,
    number,
  ]
  const planar = [10, 11, 12, 17].includes(type)
  const uniform = planar ? sx === sy : sx === sy && sy === sz
  const radiusScale = type === 12 ? sx : planar ? Math.max(sx, sy) : Math.max(sx, sy, sz)
  if (![5, 15, 16, 18].includes(type) && !uniform)
    warn('Shape: non-uniform shape scale is approximated by its largest axis.')
  const radius =
    (typeof data.radius === 'object'
      ? number(record(data.radius).value, 1)
      : number(data.radius, 1)) * radiusScale
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
    return new DonutEmitter({
      ...params,
      donutRadius: number(data.donutRadius, 0.2) * radiusScale,
    })
  if ([5, 15, 16, 18].includes(type)) {
    // Unity 2017+ stores the box/rectangle size as shape scale; older files used boxX/Y/Z.
    const width = data.boxX !== undefined ? Math.abs(number(data.boxX, 1)) : sx
    const height = data.boxY !== undefined ? Math.abs(number(data.boxY, 1)) : sy
    const depth = data.boxZ !== undefined ? Math.abs(number(data.boxZ, 1)) : sz
    if (type === 5 && depth > 0)
      warn('Shape: box volume depth is not represented; particles spawn on its central XY plane.')
    if (type === 15 || type === 16)
      warn('Shape: box shell/edge emission is approximated by the box cross-section area.')
    // Unity Box/Rectangle emit across the area along +Z; Quarks RectangleEmitter emits outward
    // from its perimeter, so the native grid is the matching shape.
    return new GridEmitter({ width, height, row: GRID_CELLS, column: GRID_CELLS })
  }
  warn(`Shape type ${type} is unsupported; using point emission.`)
  return new PointEmitter()
}

/**
 * A Unity local-space Force over Lifetime as the world-space acceleration Quarks applies.
 * Constants rotate exactly; curves/randoms are exact only under axis-aligned rotations.
 */
function localForce(
  force: RecordValue,
  node: THREE.Object3D,
  make: (input: unknown, axis: string, factor: number) => Scalar,
): ForceOverLife | undefined {
  node.updateWorldMatrix(true, false)
  // Columns are the three.js world directions of Unity's local X, Y and Z (Z reflected).
  const m = new THREE.Matrix4()
    .makeRotationFromQuaternion(node.getWorldQuaternion(new THREE.Quaternion()))
    .multiply(new THREE.Matrix4().makeScale(1, 1, -1)).elements
  const inputs = [force.x, force.y, force.z]
  const axes = ['X', 'Y', 'Z']
  const generators = inputs.map((input, i) => make(input, axes[i]!, 1))
  const clean = (v: number) => (Math.abs(v) < 1e-9 ? 0 : v)
  if (generators.every((generator) => generator instanceof ConstantValue)) {
    const world = [0, 1, 2].map((row) =>
      generators.reduce(
        (sum, generator, column) => sum + m[column * 4 + row]! * (generator as ConstantValue).value,
        0,
      ),
    )
    return new ForceOverLife(
      new ConstantValue(clean(world[0]!)),
      new ConstantValue(clean(world[1]!)),
      new ConstantValue(clean(world[2]!)),
    )
  }
  const rows: Scalar[] = []
  for (let row = 0; row < 3; row++) {
    const column = [0, 1, 2].find((c) => Math.abs(m[c * 4 + row]!) > 1 - 1e-6)
    if (column === undefined) return undefined
    rows.push(make(inputs[column], axes[column]!, Math.sign(m[column * 4 + row]!)))
  }
  return new ForceOverLife(rows[0]!, rows[1]!, rows[2]!)
}

/** Unity's default-resources ("extra") GUID for built-in shaders and materials. */
const BUILTIN_EXTRA_GUID = '0000000000000000f000000000000000'
interface BuiltinShader {
  /** Tint property, or undefined for shaders without a material tint. */
  tint?: string
  /** 'floats': blend/depth/cull come from the material's _SrcBlend/_DstBlend/_ZWrite/_Cull. */
  blend: 'floats' | { src: number; dst: number }
}
/**
 * Built-in shaders by default-resources fileID. Standard (45, 46) and Particles/Standard
 * Surface/Unlit (210, 211) declare blend properties; UI/Default (10770) and the Mobile particle
 * shaders (10720 Additive, 10721 Alpha Blended) have fixed blending, no depth writes or culling,
 * and the mobile ones have no tint, so properties saved by earlier shaders are ignored.
 */
const BUILTIN_SHADERS: Record<string, BuiltinShader> = {
  '45': { tint: '_Color', blend: 'floats' },
  '46': { tint: '_Color', blend: 'floats' },
  '210': { tint: '_Color', blend: 'floats' },
  '211': { tint: '_Color', blend: 'floats' },
  '10720': { blend: { src: 5, dst: 1 } },
  '10721': { blend: { src: 5, dst: 10 } },
  '10770': { tint: '_Color', blend: { src: 5, dst: 10 } },
}
const BLEND_PROPERTIES = ['_SrcBlend', '_DstBlend', '_BlendOp', '_ZWrite', '_Cull']
/** Built-in Default-Particle material: a soft white sprite with alpha blending. */
const BUILTIN_DEFAULT_PARTICLE = '10301'
const COLOR_PROPERTIES = ['_BaseColor', '_TintColor', '_Color']
// UnityEngine.Rendering.BlendMode and BlendOp, in enum order.
const BLEND_FACTORS = [
  THREE.ZeroFactor,
  THREE.OneFactor,
  THREE.DstColorFactor,
  THREE.SrcColorFactor,
  THREE.OneMinusDstColorFactor,
  THREE.SrcAlphaFactor,
  THREE.OneMinusSrcColorFactor,
  THREE.DstAlphaFactor,
  THREE.OneMinusDstAlphaFactor,
  THREE.SrcAlphaSaturateFactor,
  THREE.OneMinusSrcAlphaFactor,
] as const
const BLEND_NAMES = [
  'Zero',
  'One',
  'DstColor',
  'SrcColor',
  'OneMinusDstColor',
  'SrcAlpha',
  'OneMinusSrcColor',
  'DstAlpha',
  'OneMinusDstAlpha',
  'SrcAlphaSaturate',
  'OneMinusSrcAlpha',
]
const BLEND_EQUATIONS = [
  THREE.AddEquation,
  THREE.SubtractEquation,
  THREE.ReverseSubtractEquation,
  THREE.MinEquation,
  THREE.MaxEquation,
] as const

/** Property names declared in a ShaderLab Properties block. */
function shaderProperties(source: string): Set<string> {
  const start = /\bProperties\s*\{/.exec(source)
  if (!start) return new Set()
  let depth = 0,
    end = start.index + start[0].length - 1
  for (; end < source.length; end++) {
    if (source[end] === '{') depth++
    else if (source[end] === '}' && --depth === 0) break
  }
  const block = source.slice(start.index + start[0].length, end)
  return new Set(
    [...block.matchAll(/^\s*(?:\[[^\]]*\]\s*)*(_\w+)\s*\(/gm)].map((match) => match[1]!),
  )
}

/** The first fixed-function Blend directive of a ShaderLab source; [_Prop] reads a material float. */
function shaderBlend(
  source: string,
  floats: RecordValue,
): { src: number; dst: number } | 'opaque' | undefined {
  const code = source.replace(/\/\/.*$/gm, '')
  const match = /^\s*Blend\s+(Off|[^\s,]+)(?:\s+([^\s,]+))?/m.exec(code)
  if (!match) {
    // Surface shaders generate their blend state from #pragma surface options.
    const surface = /^\s*#pragma\s+surface\b(.*)$/m.exec(code)?.[1] ?? ''
    if (/\bdecal:add\b/.test(surface)) return { src: 1, dst: 1 }
    if (/\balpha:premul\b/.test(surface)) return { src: 1, dst: 10 }
    if (/\b(alpha(:fade|:blend)?|decal:blend)(?=\s|$)/.test(surface)) return { src: 5, dst: 10 }
    return 'opaque'
  }
  if (match[1] === 'Off') return 'opaque'
  const factor = (token: string | undefined) => {
    const property = /^\[(\w+)\]$/.exec(token ?? '')?.[1]
    if (property) return floats[property] === undefined ? undefined : number(floats[property])
    const index = BLEND_NAMES.findIndex((name) => name.toLowerCase() === token?.toLowerCase())
    return index < 0 ? undefined : index
  }
  const src = factor(match[1]),
    dst = factor(match[2])
  if (src === undefined || dst === undefined) return undefined
  // A fragment that premultiplies its own color by alpha (`color.rgb *= color.a`, as UI particle
  // shaders do) under Blend One X blends like SrcAlpha X with Quarks' unpremultiplied output.
  if (src === 1 && /\.rgb\s*\*=\s*[\w.]+\.a\b/.test(code)) return { src: 5, dst }
  return { src, dst }
}

/** Minimal RGBA PNG encoder for generated built-in textures (zlib via CompressionStream). */
async function encodePng(width: number, height: number, rgba: Uint8Array): Promise<string> {
  const raw = new Uint8Array((width * 4 + 1) * height)
  for (let y = 0; y < height; y++)
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1)
  const deflated = new Uint8Array(
    await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate')),
    ).arrayBuffer(),
  )
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, data.length)
    out.set(new TextEncoder().encode(type), 4)
    out.set(data, 8)
    let crc = 0xffffffff
    for (const byte of out.subarray(4, 8 + data.length))
      crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
    view.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0)
    return out
  }
  const header = new Uint8Array(13)
  new DataView(header.buffer).setUint32(0, width)
  new DataView(header.buffer).setUint32(4, height)
  header.set([8, 6, 0, 0, 0], 8)
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflated),
    chunk('IEND', new Uint8Array(0)),
  ]
  let binary = ''
  for (const part of parts) for (const byte of part) binary += String.fromCharCode(byte)
  return `data:image/png;base64,${btoa(binary)}`
}

/**
 * The merged (composite) image of an 8-bit Grayscale/RGB Photoshop file, which is what Unity
 * imports. Raw and PackBits (RLE) image data are supported; a fourth channel is alpha. With
 * Unity's "Remove Matte (PSD)" option, colors are un-matted from the white composite background.
 */
export function decodePsd(
  bytes: Uint8Array,
  removeMatte = false,
): { width: number; height: number; rgba: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const fail = (reason: string): never => {
    throw new Error(`Unsupported or malformed PSD: ${reason}.`)
  }
  let offset = 0
  const need = (length: number) => {
    if (offset + length > bytes.length) fail('truncated file')
  }
  const u16 = () => (need(2), (offset += 2), view.getUint16(offset - 2))
  const u32 = () => (need(4), (offset += 4), view.getUint32(offset - 4))
  const skip = (length: number) => (need(length), (offset += length))
  if (u32() !== 0x38425053) fail('missing 8BPS signature')
  if (u16() !== 1) fail('large-document (PSB) files are not supported')
  skip(6)
  const channels = u16()
  const height = u32()
  const width = u32()
  const depth = u16()
  const mode = u16()
  if (depth !== 8) fail(`${depth}-bit channels`)
  if (mode !== 1 && mode !== 3) fail('only Grayscale and RGB color modes are supported')
  const colorChannels = mode === 3 ? 3 : 1
  if (channels < colorChannels || channels > 56) fail('invalid channel count')
  if (!width || !height || width > 8192 || height > 8192) fail('dimensions must be 1–8192 pixels')
  skip(u32()) // color mode data
  skip(u32()) // image resources
  skip(u32()) // layer and mask information
  const compression = u16()
  const used = Math.min(channels, colorChannels + 1)
  const plane = width * height
  const planes = Array.from({ length: used }, () => new Uint8Array(plane))
  if (compression === 0) {
    for (const data of planes) {
      need(plane)
      data.set(bytes.subarray(offset, offset + plane))
      offset += plane
    }
  } else if (compression === 1) {
    const counts: number[] = []
    for (let i = 0; i < channels * height; i++) counts.push(u16())
    for (let channel = 0; channel < used; channel++)
      for (let row = 0; row < height; row++) {
        const end = offset + counts[channel * height + row]!
        if (end > bytes.length) fail('truncated RLE data')
        const data = planes[channel]!
        let x = row * width
        const rowEnd = x + width
        while (offset < end) {
          const header = (bytes[offset++]! << 24) >> 24
          if (header >= 0) {
            const length = header + 1
            if (x + length > rowEnd || offset + length > end) fail('RLE row overflow')
            data.set(bytes.subarray(offset, offset + length), x)
            offset += length
            x += length
          } else if (header !== -128) {
            const length = 1 - header
            if (x + length > rowEnd || offset >= end) fail('RLE row overflow')
            data.fill(bytes[offset++]!, x, x + length)
            x += length
          }
        }
        if (x !== rowEnd) fail('RLE row length mismatch')
      }
  } else fail(`compression ${compression}`)
  const rgba = new Uint8Array(plane * 4)
  const alpha = planes[colorChannels]
  for (let i = 0; i < plane; i++) {
    const a = alpha ? alpha[i]! : 255
    for (let c = 0; c < 3; c++) {
      let value = planes[colorChannels === 3 ? c : 0]![i]!
      if (removeMatte && alpha && a > 0 && a < 255)
        value = Math.max(0, Math.min(255, Math.round(((value - (255 - a)) * 255) / a)))
      rgba[i * 4 + c] = value
    }
    rgba[i * 4 + 3] = a
  }
  return { width, height, rgba }
}

/** An approximation of Unity's Default-Particle texture: white with a smooth radial alpha falloff. */
async function defaultParticleTexture(): Promise<string> {
  const size = 64
  const pixels = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2)
      const t = Math.max(0, 1 - r)
      pixels.set([255, 255, 255, Math.round(255 * t * t * (3 - 2 * t))], (y * size + x) * 4)
    }
  return encodePng(size, size, pixels)
}

/** The GameObjects, Transforms and components under `root`, with `root` detached from its parent. */
function subtree(docs: UnityObject[], root: string): UnityObject[] {
  const transforms = docs.filter((doc) => doc.type === 'Transform' || doc.type === 'RectTransform')
  if (!transforms.some((doc) => doc.id === root))
    throw new Error(`Transform ${root} is not in the prefab.`)
  const kept = new Set([root])
  for (let grew = true; grew;) {
    grew = false
    for (const doc of transforms)
      if (!kept.has(doc.id) && kept.has(fileId(doc.value.m_Father))) {
        kept.add(doc.id)
        grew = true
      }
  }
  const objects = new Set(
    transforms.filter((doc) => kept.has(doc.id)).map((doc) => fileId(doc.value.m_GameObject)),
  )
  const top = fileId(transforms.find((doc) => doc.id === root)!.value.m_GameObject)
  return docs.flatMap((doc) => {
    if (doc.id === top) return [{ ...doc, value: { ...doc.value, m_IsActive: 1 } }]
    if (doc.id === root)
      return [
        {
          ...doc,
          value: { ...doc.value, m_Father: { fileID: '0' }, m_LocalPosition: { x: 0, y: 0, z: 0 } },
        },
      ]
    return objects.has(doc.id) || objects.has(fileId(doc.value.m_GameObject)) ? [doc] : []
  })
}

/**
 * Converts a Unity prefab (with its nested prefabs and variants) to a native Quarks document.
 * `assets` maps GUIDs to the prefab's dependencies.
 */
export async function convertUnityPrefab(
  asset: Asset,
  assets: ReadonlyMap<string, Asset>,
  options: UnityConvertOptions = {},
): Promise<UnityPrefabImport> {
  const warnings = new Set<string>()
  const warn: Warn = (message) => warnings.add(message)
  const resolved = resolvePrefabObjects(asset, assets, warn)
  const docs = options.root ? subtree(resolved, options.root) : resolved
  const readTexture =
    options.readTexture ??
    ((data, path, type) => readTextureFile(new File([data], path.split('/').at(-1)!, { type })))
  const particles = docs.filter((doc) => doc.type === 'ParticleSystem')
  if (!particles.length) throw new Error(`${asset.path}: no Shuriken Particle Systems found.`)
  if (particles.length > 512) throw new Error('A prefab must not exceed 512 Particle Systems.')
  const uiParticles = docs.filter(isUIParticle)
  // A UI canvas has no depth: UIParticle effects keep only X/Y offsets (Unity UI prefabs often carry
  // large Z values that the canvas ignores).
  const flat = uiParticles.some((doc) => enabled(doc.value.m_Enabled ?? 1))
  // An enabled UIParticle renders its listed systems through the canvas and disables their
  // ParticleSystemRenderers, so those renderers are serialized as disabled.
  const canvasRendered = new Set(
    uiParticles
      .filter((doc) => enabled(doc.value.m_Enabled ?? 1))
      .flatMap((doc) => array(doc.value.m_Particles).map(fileId)),
  )
  // Systems of an enabled UIParticle in "UIParticle" auto scaling mode keep the canvas scale.
  const canvasScaled = new Set(
    uiParticles
      .filter(
        (doc) =>
          enabled(doc.value.m_Enabled ?? 1) &&
          number(doc.value.m_AutoScalingMode, enabled(doc.value.m_AutoScaling) ? 2 : 0) === 1,
      )
      .flatMap((doc) => array(doc.value.m_Particles).map(fileId)),
  )
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
    const key = `${id}:${fileId(reference)}`
    const cached = materialCache.get(key)
    if (cached) return cached
    const source = assets.get(id)
    const result = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    materials.push(result)
    materialCache.set(key, result)
    if (!source && id === BUILTIN_EXTRA_GUID && fileId(reference) === BUILTIN_DEFAULT_PARTICLE) {
      // Built-in resources are identified by Unity's default-resources GUID and fileID.
      result.name = 'Default-Particle'
      const texture = new THREE.Texture()
      texture.name = 'Default-Particle'
      texture.colorSpace = THREE.NoColorSpace
      textureUrls.set(texture.uuid, await defaultParticleTexture())
      textureCache.set(key, texture)
      result.map = texture
      warn(
        'Default-Particle: Unity built-in material is approximated by a generated soft round sprite.',
      )
      return result
    }
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
    const keywords = new Set(
      [
        ...String(data.m_ShaderKeywords ?? '').split(/\s+/),
        ...array(data.m_ValidKeywords).map(String),
      ].filter(Boolean),
    )
    const shaderId = guid(data.m_Shader)
    const shaderAsset = assets.get(shaderId)
    const shaderSource =
      shaderAsset && /\.shader$/i.test(shaderAsset.path)
        ? decoder.decode(shaderAsset.data)
        : undefined
    const shader =
      shaderSource !== undefined
        ? (/Shader\s+"([^"]+)"/.exec(shaderSource)?.[1] ?? shaderAsset!.path)
        : '(built-in or unavailable shader)'
    shaderNames.set(id, shader)
    // Materials keep stale properties from earlier shaders, so the tint is the property the
    // current shader declares; a shader declaring none of them is untinted.
    const declared = shaderSource !== undefined ? shaderProperties(shaderSource) : undefined
    const builtin =
      shaderId === BUILTIN_EXTRA_GUID ? BUILTIN_SHADERS[fileId(data.m_Shader)] : undefined
    if (builtin)
      for (const name of BLEND_PROPERTIES) if (builtin.blend !== 'floats') delete floats[name]
    if (declared)
      // A saved float the shader does not declare is stale; [_Prop] Blend directives are read
      // from the floats by shaderBlend, so only declared properties remain.
      for (const name of BLEND_PROPERTIES) if (!declared.has(name)) delete floats[name]
    // Without the shader, saved floats may be stale defaults (Standard keeps One/Zero opaque).
    const unverified = !declared && !builtin
    let tintProperty: string | undefined
    if (declared) tintProperty = COLOR_PROPERTIES.find((name) => declared.has(name))
    else if (builtin) tintProperty = builtin.tint
    else {
      const present = COLOR_PROPERTIES.filter((name) => colors[name] !== undefined)
      tintProperty = present[0]
      // Integer channels parse as BigInt, so compare normalized numbers rather than YAML values.
      const values = present.map((name) => rgba(colors[name]).toArray().join(','))
      if (new Set(values).size > 1)
        warn(
          `${source.path}: shader is unavailable; tint uses ${tintProperty} among differing ${present.join('/')} values.`,
        )
    }
    const tint = tintProperty ? rgba(colors[tintProperty]) : new QVector4(1, 1, 1, 1)
    // The Quarks unlit shader writes colors without output encoding, matching Unity's displayed
    // (gamma) values: serialized colors are therefore used without color-space conversion.
    result.color.setRGB(tint.x, tint.y, tint.z, THREE.LinearSRGBColorSpace)
    result.opacity = tint.w
    if (floats._ZWrite !== undefined && !unverified) result.depthWrite = enabled(floats._ZWrite)
    if (floats._Cull !== undefined && !unverified)
      result.side =
        number(floats._Cull) === 0
          ? THREE.DoubleSide
          : number(floats._Cull) === 1
            ? THREE.BackSide
            : THREE.FrontSide
    if (enabled(floats._AlphaClip) || enabled(floats._AlphaTest) || keywords.has('_ALPHATEST_ON'))
      result.alphaTest = number(floats._Cutoff, 0.5)
    let blend =
      builtin && builtin.blend !== 'floats'
        ? builtin.blend
        : floats._SrcBlend !== undefined && floats._DstBlend !== undefined
          ? { src: number(floats._SrcBlend), dst: number(floats._DstBlend) }
          : shaderSource !== undefined
            ? shaderBlend(shaderSource, floats)
            : undefined
    const op = Math.floor(number(floats._BlendOp))
    if (
      unverified &&
      blend !== undefined &&
      blend !== 'opaque' &&
      blend.src === 1 &&
      blend.dst === 0
    ) {
      // An opaque state read from unverifiable floats would turn transparent texels into
      // solid quads; alpha blending renders opaque texels identically.
      warn(
        `${source.path}: shader is unavailable and its saved blend floats (One/Zero) may be stale; using normal alpha blending. Include the shader in the package for exact blending.`,
      )
      blend = undefined
    } else if (blend === undefined)
      warn(`${source.path}: blend state is unavailable; using normal alpha blending.`)
    if (blend === undefined) {
      // Normal alpha blending: the material defaults.
    } else if (blend === 'opaque' || (blend.src === 1 && blend.dst === 0 && op === 0)) {
      result.transparent = false
      result.depthWrite = true
    } else if (
      BLEND_FACTORS[blend.src] === undefined ||
      BLEND_FACTORS[blend.dst] === undefined ||
      BLEND_EQUATIONS[op] === undefined
    )
      warn(`${source.path}: unknown blend factors; using normal alpha blending.`)
    else if (blend.src === 5 && blend.dst === 10 && op === 0) result.blending = THREE.NormalBlending
    else if (blend.src === 5 && blend.dst === 1 && op === 0)
      result.blending = THREE.AdditiveBlending
    else {
      result.blending = THREE.CustomBlending
      result.blendSrc = BLEND_FACTORS[blend.src]!
      result.blendDst = BLEND_FACTORS[blend.dst]! as THREE.BlendingDstFactor
      result.blendEquation = BLEND_EQUATIONS[op]!
    }
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
        else if (!/\.(png|jpe?g|webp|gif|psd)$/i.test(image.path))
          warn(
            `${image.path}: texture format is not supported; convert it to PNG in Unity before exporting.`,
          )
        else {
          const extension = image.path.split('.').at(-1)!.toLowerCase()
          const importer = image.meta
            ? record(yaml(decoder.decode(image.meta)).TextureImporter)
            : {}
          let url: string | undefined
          if (extension === 'psd') {
            if (image.data.length > 16 * MB) warn(`${image.path}: texture exceeds 16 MB.`)
            else
              try {
                const { width, height, rgba } = decodePsd(
                  image.data,
                  enabled(importer.pSDRemoveMatte),
                )
                url = await encodePng(width, height, rgba)
                warn(
                  `${image.path}: Photoshop texture is converted from its merged composite image to PNG.`,
                )
              } catch (error) {
                warn(
                  `${image.path}: ${error instanceof Error ? error.message : 'invalid PSD'} Convert it to PNG in Unity before exporting.`,
                )
              }
          } else
            url = await readTexture(
              image.data,
              image.path,
              `image/${extension === 'jpg' ? 'jpeg' : extension}`,
            )
          if (url) {
            texture = new THREE.Texture()
            texture.name = image.path
            // Quarks' unlit particle shader does not encode its output, so decoding sRGB texels
            // would darken them; raw sampling reproduces Unity's displayed texture colors.
            texture.colorSpace = THREE.NoColorSpace
            textureUrls.set(texture.uuid, url)
            textureCache.set(textureId, texture)
            const settings = record(importer.textureSettings)
            const wrap = (value: unknown) =>
              number(value) === 1
                ? THREE.ClampToEdgeWrapping
                : number(value) === 2
                  ? THREE.MirroredRepeatWrapping
                  : THREE.RepeatWrapping
            texture.wrapS = wrap(settings.wrapU ?? settings.wrapMode)
            texture.wrapT = wrap(settings.wrapV ?? settings.wrapMode)
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
        (doc.type === 'MonoBehaviour' && !isUIParticle(doc)) ||
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
      node.position.set(number(p.x), number(p.y), flat ? 0 : -number(p.z) || 0)
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
    const depth = (node: THREE.Object3D) => {
      let count = 0
      for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) count++
      return count
    }
    const uiParticleReport: RecordValue[] = []
    for (const doc of uiParticles
      .filter((doc) => nodes.has(fileId(doc.value.m_GameObject)))
      .sort(
        (a, b) =>
          depth(nodes.get(fileId(a.value.m_GameObject))!) -
          depth(nodes.get(fileId(b.value.m_GameObject))!),
      )) {
      const node = nodes.get(fileId(doc.value.m_GameObject))!
      const data = doc.value
      const active = enabled(data.m_Enabled ?? 1)
      // UIParticle 4.x: None, UIParticle, Transform. The legacy m_AutoScaling flag meant Transform.
      const scalingMode =
        data.m_AutoScalingMode !== undefined
          ? number(data.m_AutoScalingMode)
          : enabled(data.m_AutoScaling)
            ? 2
            : 0
      const scale3D = record(data.m_Scale3D)
      const scale =
        data.m_Scale3D !== undefined
          ? ['x', 'y', 'z'].map((axis) => number(scale3D[axis], 1))
          : Array<number>(3).fill(number(data.m_Scale, 1))
      if (active && scalingMode === 2) {
        // Transform mode drives localScale so the world scale is one; Unity serializes driven
        // RectTransform properties as zero, so the saved scale is not the runtime value.
        node.parent!.updateWorldMatrix(true, false)
        const parentScale = node.parent!.getWorldScale(new THREE.Vector3())
        node.scale.set(
          ...(parentScale.toArray().map((value) => (value ? 1 / value : 1)) as [
            number,
            number,
            number,
          ]),
        )
      }
      const listed = array(data.m_Particles).map(fileId)
      uiParticleReport.push({
        gameObject: node.name,
        enabled: active,
        scale,
        autoScalingMode: scalingMode,
        positionMode: number(data.m_PositionMode),
        particleSystems: listed.length,
      })
      if (!active) continue
      warn(
        `${node.name}: UIParticle renders ${listed.length} Particle System(s) on a UI canvas at scale ${scale.join(' × ')}; the effect is converted in particle units, so scale it by that factor to match canvas pixels.`,
      )
      if (number(data.m_PositionMode) === 1)
        warn(
          `${node.name}: UIParticle Absolute position mode does not scale emitter offsets; positions are converted unscaled.`,
        )
      if (enabled(data.m_IsTrail))
        warn(`${node.name}: UIParticle trail rendering is not converted.`)
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
      const value = (input: unknown, fallback: number, label: string, factor = 1, offset = 0) =>
        scalar(input, fallback, localWarn, label, factor, offset)
      const mode = number(renderer.m_RenderMode)
      const simulationSpace = number(data.moveWithTransform)
      const geometry = mode === 4 ? await mesh(renderer.m_Mesh, localWarn) : undefined
      // Trails module (Particles mode): Quarks draws each particle as its trail ribbon instead of
      // a sprite with a trail, so the particle sprite itself is not drawn.
      const trail = record(data.TrailModule)
      const trails = enabled(trail.enabled) && number(trail.mode) === 0 && !geometry
      const renderMode = trails
        ? RenderMode.Trail
        : geometry
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
      // Unity draws trails with the renderer's second (trail) material.
      const trailMaterial = trails && fileId(refs[1]) !== '0' ? refs[1] : undefined
      if (!trails && refs.slice(1).some((reference) => fileId(reference) !== '0'))
        localWarn('Only the first renderer material is used.')
      const mat = await material(trailMaterial ?? refs[0])
      const behaviors = []
      const convertedModules = new Set<string>()
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
              : // Quarks' runtime and JSON loader accept per-particle value generators here,
                // although its TypeScript signature only lists function generators.
                (value(size.curve, 1, 'Size over Lifetime') as unknown as PiecewiseBezier),
          ),
        )
      // UIParticle's "UIParticle" scaling keeps the canvas scale on its systems' particles, while
      // world-unit values (gravity, trail ribbon widths) stay in world units: relative to the
      // particles they are scaled by the canvas world scale.
      let canvasScale = 1
      if (canvasScaled.has(doc.id)) {
        if (options.canvasWorldScale) canvasScale = options.canvasWorldScale
        else
          localWarn(
            'UIParticle scaling: gravity and trail widths depend on the UI canvas world scale, which is not given; using 1.',
          )
      }
      // A system in Local scaling mode does not inherit the canvas scale, so UIParticle multiplies
      // its baked mesh by the root canvas scale (UIParticleRenderer.GetWorldScale): its world-space
      // gravity then keeps its size relative to the particles. Trail widths still follow the canvas.
      const gravityScale = number(data.scalingMode) === 1 ? 1 : canvasScale
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
            value(
              initial.gravityModifier,
              0,
              'Gravity Modifier',
              (options.gravity ?? -9.81) * gravityScale,
            ),
            new ConstantValue(0),
          ),
        )
      if (hasGravity && options.gravity === undefined)
        localWarn(
          'Gravity Modifier: using Unity default gravity (-9.81 m/s²); project settings are not in the package.',
        )
      if (hasGravity && [1, 2].includes(gravityMode))
        localWarn('Gravity Modifier: the curve is evaluated over particle age, not system time.')
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
      const force = record(data.ForceModule)
      if (enabled(force.enabled)) {
        // Quarks ForceOverLife is a world-space acceleration in both simulation spaces.
        const forceBehavior = enabled(force.inWorldSpace)
          ? new ForceOverLife(
              value(force.x, 0, 'Force X'),
              value(force.y, 0, 'Force Y'),
              value(force.z, 0, 'Force Z', -1),
            )
          : localForce(force, parent, (input, axis, factor) =>
              value(input, 0, `Force ${axis}`, factor),
            )
        if (forceBehavior) {
          behaviors.push(forceBehavior)
          convertedModules.add('ForceModule')
          if (!enabled(force.inWorldSpace))
            localWarn(
              'Force: local-space direction is baked from the prefab hierarchy and does not follow runtime rotation of the effect.',
            )
          if (enabled(force.randomizePerFrame))
            localWarn('Force: per-frame randomization is approximated by per-particle values.')
        } else
          localWarn(
            'Force: local-space curves/random values under a non-axis-aligned rotation cannot be represented.',
          )
      }
      const noise = record(data.NoiseModule)
      if (enabled(noise.enabled)) {
        behaviors.push(
          new Noise(
            scalar(noise.frequency, 1, localWarn, 'Noise frequency'),
            scalar(noise.strength, 1, localWarn, 'Noise strength'),
            scalar(noise.positionAmount, 1, localWarn, 'Noise position amount'),
            scalar(noise.rotationAmount, 0, localWarn, 'Noise rotation amount'),
          ),
        )
        convertedModules.add('NoiseModule')
        localWarn('Noise: Quarks simplex noise differs from Unity noise sampling.')
        if (enabled(noise.separateAxes))
          localWarn('Noise: separate-axis strength is approximated using the X strength.')
        if (number(noise.octaves, 1) !== 1) localWarn('Noise: multiple octaves are not converted.')
        if (!enabled(noise.damping ?? 1)) localWarn('Noise: disabled damping is not converted.')
        if (number(record(noise.scrollSpeed).scalar, number(noise.scrollSpeed)))
          localWarn('Noise: scroll speed is not converted.')
        if (enabled(noise.remapEnabled)) localWarn('Noise: remapping is not converted.')
        if (number(record(noise.sizeAmount).scalar, number(noise.sizeAmount)))
          localWarn('Noise: size amount is not converted.')
      }
      const rotationBySpeed = record(data.RotationBySpeedModule)
      if (enabled(rotationBySpeed.enabled)) {
        const range = record(rotationBySpeed.range)
        const min = number(range.x),
          max = number(range.y)
        if (!geometry && min !== max) {
          behaviors.push(
            new RotationBySpeed(
              value(rotationBySpeed.curve, 0, 'Rotation by Speed', -1),
              new IntervalValue(Math.min(min, max), Math.max(min, max)),
            ),
          )
          convertedModules.add('RotationBySpeedModule')
          localWarn('Rotation by Speed: Quarks uses start speed rather than instantaneous speed.')
          if (enabled(rotationBySpeed.separateAxes))
            localWarn('Rotation by Speed: separate-axis rotation is approximated by its Z curve.')
        }
      }
      const limit = record(data.ClampVelocityModule)
      if (enabled(limit.enabled)) {
        if (enabled(limit.separateAxis ?? limit.separateAxes))
          localWarn('Limit Velocity: separate-axis limits are not converted.')
        else {
          behaviors.push(
            new LimitSpeedOverLife(
              // Runtime/JSON accept value generators; see SizeOverLife above.
              value(limit.magnitude, 1, 'Speed limit') as unknown as PiecewiseBezier,
              quarksDampen(Math.max(0, Math.min(1, number(limit.dampen, 1)))),
            ),
          )
          localWarn(
            'Limit Velocity: damping is matched at 30 FPS steps; motion may differ slightly.',
          )
        }
        if (
          number(record(limit.drag).scalar) ||
          number(record(limit.drag).minMaxState) ||
          number(limit.drag)
        )
          localWarn('Limit Velocity: drag is not converted.')
      }
      const startLife = value(initial.startLifetime, 5, 'Start Lifetime')
      // Trail width: the trail's own width, times the particle size when size affects width.
      const sizedTrail = enabled(trail.sizeAffectsWidth)
      let trailWidth: Scalar = new ConstantValue(1)
      let trailSizeFactor = 1
      let trailLength = 0
      if (trails) {
        convertedModules.add('TrailModule')
        // Unity builds trail ribbons in world units, so their width scales with the canvas too.
        trailWidth = value(trail.widthOverTrail, 1, 'Trail width', canvasScale)
        if (sizedTrail) {
          if (trailWidth instanceof PiecewiseBezier)
            localWarn(
              'Trails: width over trail is not combined with particle size; its scale is used.',
            )
          trailSizeFactor =
            canvasScale *
            number(record(trail.widthOverTrail).scalar, number(trail.widthOverTrail, 1))
        } else {
          if (trailWidth instanceof PiecewiseBezier) behaviors.push(new WidthOverLength(trailWidth))
          for (let i = behaviors.length - 1; i >= 0; i--)
            if (behaviors[i] instanceof SizeOverLife) behaviors.splice(i, 1)
        }
        const overTrail = record(trail.colorOverTrail)
        if (number(overTrail.minMaxState) === 1)
          behaviors.push(
            new ColorOverTrail(gradient(overTrail.maxGradient, localWarn, 'Color over Trail')),
          )
        else if (
          number(overTrail.minMaxState) !== 0 ||
          JSON.stringify(rgba(overTrail.maxColor)) !== JSON.stringify(rgba({}))
        )
          localWarn('Trails: colorOverTrail other than a gradient is not converted.')
        // Quarks records one trail point per update; Unity's trail lifetime is a fraction of the
        // particle lifetime. Convert it to a point count at 60 updates per second.
        const lifetime = number(record(trail.lifetime).scalar, number(trail.lifetime, 1))
        trailLength = Math.max(
          2,
          Math.ceil(lifetime * number(record(initial.startLifetime).scalar, 5) * 60),
        )
        localWarn('Trails: particles are drawn as their trails only; trail length assumes 60 FPS.')
        if (!enabled(trail.inheritParticleColor ?? 1))
          localWarn(
            'Trails: trail colors that do not inherit the particle color are not converted.',
          )
        const overLifetime = record(trail.colorOverLifetime)
        if (
          number(overLifetime.minMaxState) !== 0 ||
          JSON.stringify(rgba(overLifetime.maxColor)) !== JSON.stringify(rgba({}))
        )
          localWarn('Trails: colorOverLifetime is not converted.')
      }
      const trailSize = (fallback: Scalar | Vector3Function) =>
        !trails || sizedTrail
          ? fallback
          : trailWidth instanceof PiecewiseBezier
            ? new ConstantValue(1)
            : systemValue(trailWidth)
      const startColorData = record(initial.startColor)
      // Unity's Random Color mode picks a random point of the gradient for each particle.
      const randomStartColor = number(startColorData.minMaxState) === 4
      if (randomStartColor)
        behaviors.unshift(
          new RandomColorFromGradient(
            gradient(startColorData.maxGradient, localWarn, 'Start Color'),
          ),
        )
      const sheet = textureSheet(record(data.UVModule), startLife, localWarn)
      if (sheet.frame) behaviors.push(new FrameOverLife(sheet.frame))
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
          !convertedModules.has(key) &&
          enabled(record(module).enabled)
        )
          localWarn(`${key} is enabled but not converted.`)
      if (number(data.simulationSpeed, 1) !== 1) localWarn('Simulation speed is not converted.')
      if (![0, 1, 2].includes(simulationSpace))
        localWarn(`Unknown simulation space ${simulationSpace}; using local space.`)
      if (simulationSpace === 2 || fileId(data.moveWithCustomTransform) !== '0')
        localWarn('Custom simulation-space transform is not converted.')
      if (!geometry && enabled(initial.rotation3D))
        localWarn('3D start rotation is approximated by its Z component.')
      if (enabled(initial.randomizeRotationDirection))
        localWarn('Randomized rotation direction is not converted.')
      const activeEmission = enabled(emission.enabled)
      const duration = Math.max(0, number(data.lengthInSec, 5))
      const looping = enabled(data.looping)
      // Unity start delay is a constant or a random constant; curves are not allowed by Unity.
      let delay = 0
      if (typeof data.startDelay === 'number' || typeof data.startDelay === 'bigint')
        delay = number(data.startDelay)
      else if (delayMode === 0) delay = number(startDelay.scalar)
      else if (delayMode === 3) {
        delay = (number(startDelay.scalar) + number(startDelay.minScalar)) / 2
        localWarn('Start delay: a random delay is approximated by its midpoint.')
      } else localWarn(`Start delay: unsupported mode ${delayMode} is not converted.`)
      delay = Math.max(0, delay)
      // Non-looping: the timeline is extended by the delay and emission is gated until it ends.
      // Looping: Unity's delayed phase repeats every cycle, so curves/bursts are phase-shifted.
      const systemDuration = !looping && delay ? duration + delay : duration
      const delayStart = !looping && delay ? delay / systemDuration : 0
      const phase = looping && delay && duration > 0 ? (delay % duration) / duration : 0
      const continuous =
        activeEmission &&
        [emission.rateOverTime ?? emission.rate, emission.rateOverDistance].some((input) => {
          if (typeof input === 'number' || typeof input === 'bigint') return number(input) !== 0
          const rate = record(input)
          return number(rate.minMaxState) !== 0 || number(rate.scalar) !== 0
        })
      let wrappedBurst = false
      const systemValue = (generator: Scalar, gate = false): Scalar => {
        if (looping)
          return generator instanceof PiecewiseBezier ? phaseCurve(generator, phase) : generator
        if (!delayStart) return generator
        if (generator instanceof PiecewiseBezier)
          return delayCurve(generator, delayStart, gate ? 0 : undefined)
        if (!gate) return generator
        if (generator instanceof IntervalValue)
          localWarn('Start delay: a random emission rate is gated using its midpoint.')
        const rate = scalarMid(generator)
        return toCurve([flatPiece(0, 0, delayStart), flatPiece(rate, delayStart, 1)])
      }
      const timed = (input: unknown, fallback: number, label: string, factor = 1, offset = 0) =>
        systemValue(value(input, fallback, label, factor, offset))
      const bursts: {
        time: number
        count: Scalar
        cycle: number
        interval: number
        probability: number
      }[] = []
      for (const burst of activeEmission ? array(emission.m_Bursts).map(record) : []) {
        const time = number(burst.time)
        // Unity serializes infinite repetition as cycleCount 0.
        const cycles = Math.floor(number(burst.cycleCount, 1))
        const interval = number(burst.repeatInterval, 0)
        // Quarks 0.17.1 fires each burst once per loop and ignores cycle/interval: expand them.
        for (let k = 0; cycles <= 0 || k < cycles; k++) {
          const at = time + k * interval
          // In a loop, time `duration` is the next cycle's time 0, which already has this burst.
          if (at > duration || (looping && k > 0 && at >= duration) || (k > 0 && !(interval > 0)))
            break
          if (bursts.length >= 10000)
            throw new Error(`${label}: burst repetitions exceed 10000 per Particle System.`)
          if (looping && at + delay >= duration) wrappedBurst = true
          bursts.push({
            time: looping ? (duration > 0 ? (at + delay) % duration : at) : at + delay,
            count: burst.countCurve
              ? value(burst.countCurve, 1, 'Burst count')
              : new IntervalValue(number(burst.minCount, 1), number(burst.maxCount, 1)),
            cycle: 1,
            interval: Math.max(0, interval),
            probability: number(burst.probability, 1),
          })
        }
      }
      // Quarks scans bursts in array order and stops at the first future burst.
      bursts.sort((a, b) => a.time - b.time)
      // Before the delay ends, Unity emits nothing; a phase-shifted loop already emits then.
      if (looping && delay > 0 && (continuous || wrappedBurst))
        localWarn(
          'Start delay: the first looping cycle begins immediately rather than after the delay.',
        )
      const system = new ParticleSystem({
        material: mat,
        instancingGeometry: geometry,
        autoDestroy: false,
        duration: systemDuration,
        looping,
        prewarm: enabled(data.prewarm),
        worldSpace: simulationSpace === 1,
        shape: shape(data.ShapeModule, localWarn, !!geometry),
        startLife: systemValue(startLife),
        startSpeed: timed(initial.startSpeed, 5, 'Start Speed'),
        startSize: trailSize(
          enabled(initial.size3D)
            ? new Vector3Function(
                timed(initial.startSize, 1, 'Start Size X', trailSizeFactor),
                timed(initial.startSizeY, 1, 'Start Size Y', trailSizeFactor),
                timed(initial.startSizeZ, 1, 'Start Size Z', trailSizeFactor),
              )
            : timed(initial.startSize, 1, 'Start Size', trailSizeFactor),
        ),
        // Preserve mesh orientation when replacing the reflected emitter with an X half-turn.
        startRotation: geometry
          ? enabled(initial.rotation3D)
            ? new EulerGenerator(
                timed(initial.startRotationX, 0, 'Start Rotation X', -1),
                timed(initial.startRotationY, 0, 'Start Rotation Y'),
                timed(initial.startRotation, 0, 'Start Rotation Z', -1, Math.PI),
                'YXZ',
              )
            : new EulerGenerator(
                new ConstantValue(0),
                timed(initial.startRotation, 0, 'Start Rotation'),
                new ConstantValue(Math.PI),
                'YXZ',
              )
          : timed(initial.startRotation, 0, 'Start Rotation', -1),
        startColor: randomStartColor
          ? new ConstantColor(new QVector4(1, 1, 1, 1))
          : color(initial.startColor, localWarn, 'Start Color'),
        emissionOverTime: activeEmission
          ? systemValue(value(emission.rateOverTime ?? emission.rate, 10, 'Emission rate'), true)
          : new ConstantValue(0),
        emissionOverDistance: activeEmission
          ? systemValue(value(emission.rateOverDistance, 0, 'Distance emission'), true)
          : new ConstantValue(0),
        emissionBursts: bursts,
        renderMode,
        renderOrder: number(renderer.m_SortingOrder),
        rendererEmitterSettings: trails
          ? { startLength: new ConstantValue(trailLength), followLocalOrigin: false }
          : mode === 1
            ? {
                speedFactor: number(renderer.m_VelocityScale),
                lengthFactor: number(renderer.m_LengthScale, 2),
              }
            : {},
        uTileCount: sheet.tilesX,
        vTileCount: sheet.tilesY,
        startTileIndex: sheet.startTileIndex,
        behaviors,
      })
      systems.push(system)
      systemsByUnityId.set(doc.id, system)
      system.emitter.name = label
      system.emitter.visible =
        mode !== 5 && (enabled(renderer.m_Enabled ?? 1) || canvasRendered.has(doc.id))
      for (let ancestor: THREE.Object3D | null = parent; ancestor; ancestor = ancestor.parent)
        system.emitter.visible &&= ancestor.visible
      const shapeData = record(data.ShapeModule)
      const shapeEnabled = enabled(shapeData.enabled)
      // Negative emitter scale makes Quarks world-space positions and velocities disagree.
      // Unity Edge emits along +Y, while the native grid emits along +Z.
      const basis = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        !geometry && shapeEnabled && number(shapeData.type) === 12 ? -Math.PI / 2 : Math.PI,
      )
      // Shape position/rotation move spawn positions and directions within the system; they are
      // applied to the emitter with the same Z reflection as GameObject transforms.
      const offset = record(shapeData.m_Position)
      const euler = record(shapeData.m_Rotation)
      const shapeRotation = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          THREE.MathUtils.degToRad(number(euler.x)),
          THREE.MathUtils.degToRad(number(euler.y)),
          THREE.MathUtils.degToRad(number(euler.z)),
          'YXZ', // Unity applies Z, then X, then Y.
        ),
      )
      if (shapeEnabled) {
        system.emitter.position.set(number(offset.x), number(offset.y), -number(offset.z))
        shapeRotation.set(-shapeRotation.x, -shapeRotation.y, shapeRotation.z, shapeRotation.w)
      } else shapeRotation.identity()
      system.emitter.quaternion.copy(shapeRotation).multiply(basis)
      if (geometry && Math.abs(shapeRotation.w) < 1 - 1e-9)
        localWarn('Shape: rotation also rotates mesh particle orientation in Quarks.')
      parent.add(system.emitter)
    }
    for (const doc of particles) {
      const module = record(doc.value.SubModule)
      if (!enabled(module.enabled)) continue
      const owner = systemsByUnityId.get(doc.id)!
      const label = owner.emitter.name
      const localWarn: Warn = (message) => warn(`${label}: ${message}`)
      for (const subEmitter of array(module.subEmitters).map(record)) {
        // Unity keeps empty sub-emitter slots as fileID 0; they emit nothing.
        if (fileId(subEmitter.emitter) === '0') continue
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
    warn(
      'Unity maxParticles, culling, scaling modes and exact random seeds are not reproduced by Quarks.',
    )
    root.userData.unityImport = {
      source: asset.path,
      warnings: [...warnings],
      shaders: Object.fromEntries(shaderNames),
      ...(uiParticleReport.length ? { uiParticles: uiParticleReport } : {}),
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

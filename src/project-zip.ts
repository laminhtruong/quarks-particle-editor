import { Unzip, UnzipInflate } from 'three/examples/jsm/libs/fflate.module.js'
import { parseQuarksDocument } from './document.js'
import { addTextureAsset } from './folder-export.js'
import { readTextureFile, resolveTexturePaths } from './local-files.js'
import { readMeshJson, resolveMeshAssets } from './mesh-assets.js'

const MB = 1024 * 1024
const imageTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

export async function readProjectZip(file: File) {
  if (!/\.zip$/i.test(file.name) || !file.size || file.size > 128 * MB)
    throw new Error('Choose a project .zip between 1 byte and 128 MB.')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const view = new DataView(bytes.buffer)
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.length
    ) {
      end = offset
      break
    }
  }
  if (end < 0 || view.getUint32(end + 16, true) + view.getUint32(end + 12, true) !== end)
    throw new Error('Invalid or truncated project ZIP.')
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true))
    throw new Error('Multi-volume ZIP archives are not supported.')
  const entries = new Map<string, Uint8Array<ArrayBuffer>>()
  const names = new Set<string>()
  let expanded = 0
  const unzip = new Unzip((entry) => {
    const name = entry.name.replace(/^(?:\.\/)+/, '')
    if (
      (!name && !/^(?:\.\/)+$/.test(entry.name)) ||
      name.length > 4096 ||
      /[\\\u0000-\u001f]/.test(name) ||
      name.startsWith('/') ||
      /^[a-z]:/i.test(name) ||
      name.split('/').some((part) => part === '..' || part === '.')
    )
      throw new Error(`Unsafe ZIP entry path: ${name}`)
    if (names.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`)
    names.add(name)
    if (names.size > 40000) throw new Error('Project ZIP has too many entries.')
    if ((entry.originalSize ?? 0) > 64 * MB) throw new Error('A ZIP entry must not exceed 64 MB.')
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let size = 0
    entry.ondata = (error, chunk, final) => {
      if (error) throw error
      size += chunk.length
      expanded += chunk.length
      if (size > 64 * MB || expanded > 512 * MB)
        throw new Error('Expanded project ZIP exceeds the 64 MB per-file or 512 MB total limit.')
      chunks.push(new Uint8Array(chunk))
      if (final && name && !name.endsWith('/')) {
        const data = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
          data.set(chunk, offset)
          offset += chunk.length
        }
        entries.set(name, data)
      }
    }
    entry.start()
  })
  unzip.register(UnzipInflate)
  for (let offset = 0; offset < bytes.length; offset += 16384)
    unzip.push(bytes.subarray(offset, offset + 16384), offset + 16384 >= bytes.length)
  if (names.size !== view.getUint16(end + 10, true))
    throw new Error('Truncated or inconsistent project ZIP.')
  const paths = [...entries.keys()].filter((path) => !path.startsWith('__MACOSX/'))
  const rootDocuments = paths.filter((path) => /^[^/]+\.json$/i.test(path))
  const wrappedDocuments = paths.filter((path) => /^[^/]+\/[^/]+\.json$/i.test(path))
  const roots = new Set(wrappedDocuments.map((path) => path.split('/')[0]!))
  if (!rootDocuments.length && roots.size !== 1)
    throw new Error(
      'ZIP must contain one project with effect JSON files at its root, optionally inside one enclosing folder.',
    )
  const prefix = rootDocuments.length ? '' : `${[...roots][0]}/`
  const documents = rootDocuments.length ? rootDocuments : wrappedDocuments
  const urls = new Map<string, string>()
  const files = new Map<string, Blob>()
  const textures = new Map<string, string>()
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue
    const type = imageTypes[path.split('.').at(-1)!.toLowerCase()]
    if (!type) continue
    const image = new File([entries.get(path)!], path.split('/').at(-1)!, { type })
    const url = await readTextureFile(image)
    urls.set(path.slice(prefix.length), url)
    const asset = await addTextureAsset(files, image)
    textures.set(asset.split('/').at(-1)!, url)
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const effects = []
  for (const path of documents) {
    const json = parseQuarksDocument(JSON.parse(decoder.decode(entries.get(path)!)))
    await resolveMeshAssets(json, async (path) => {
      const bytes = entries.get(`${prefix}${decodeURIComponent(path)}`)
      if (!bytes) throw new Error(`Missing mesh in project ZIP: ${path}`)
      return readMeshJson(new Blob([bytes]))
    })
    await resolveTexturePaths(json, async (path) => {
      const url = urls.get(path)
      if (!url) throw new Error(`Missing texture in project ZIP: ${path}`)
      return url
    })
    effects.push({ path: path.slice(prefix.length), json })
  }
  return { effects, textures, files }
}

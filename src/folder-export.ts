import { meshGeometrySchema, parseQuarksDocument, type QuarksDocument } from './document.js'

const extensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

async function contentHash(blob: Blob): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

export async function textureAssetPath(blob: Blob): Promise<string> {
  const extension = extensions[blob.type.split(';')[0]!.trim().toLowerCase()]
  if (!extension || !blob.size)
    throw new Error(
      `Cannot export empty or unsupported texture (${blob.type || 'unknown MIME type'}).`,
    )
  return `assets/textures/${await contentHash(blob)}.${extension}`
}

async function sameContents(left: Blob, right: Blob): Promise<boolean> {
  if (left.size !== right.size) return false
  const bytes = new Uint8Array(await left.arrayBuffer())
  const expected = new Uint8Array(await right.arrayBuffer())
  return bytes.every((byte, index) => byte === expected[index])
}

export async function addFolderAsset(
  files: Map<string, Blob>,
  path: string,
  blob: Blob,
): Promise<string> {
  const previous = files.get(path)
  if (previous && !(await sameContents(previous, blob)))
    throw new Error(`Asset hash collision: ${path}`)
  files.set(path, blob)
  return path
}

export async function addTextureAsset(files: Map<string, Blob>, blob: Blob): Promise<string> {
  return addFolderAsset(files, await textureAssetPath(blob), blob)
}

/** Externalize payloads without changing native UUID references or numeric precision. */
export async function prepareFolderExport(source: QuarksDocument, baseUrl: string) {
  const json = parseQuarksDocument(structuredClone(source))
  const files = new Map<string, Blob>()
  const geometries = (json.geometries ?? []) as Record<string, unknown>[]
  for (const [index, geometry] of geometries.entries()) {
    if (geometry.url !== undefined)
      throw new Error('Resolve external meshes before saving a native document.')
    // Parametric primitives already store only a few construction parameters, not vertex arrays.
    if (geometry.data === undefined) continue
    if (typeof geometry.uuid !== 'string' || !geometry.uuid)
      throw new Error('Mesh geometry must have a UUID.')
    const { uuid, name, metadata, ...payload } = meshGeometrySchema.parse(geometry)
    const blob = new Blob(
      [
        JSON.stringify(payload, (_key, value) =>
          value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(
                Object.keys(value)
                  .sort()
                  .map((key) => [key, value[key]]),
              )
            : value,
        ),
      ],
      { type: 'application/json' },
    )
    if (blob.size > 64 * 1024 * 1024) throw new Error('Mesh JSON must not exceed 64 MB.')
    const path = await addFolderAsset(files, `assets/meshes/${await contentHash(blob)}.json`, blob)
    geometries[index] = {
      uuid,
      type: payload.type,
      ...(name === undefined ? {} : { name }),
      ...(metadata === undefined ? {} : { metadata }),
      url: path,
    }
  }
  const urls = new Map<string, string>()
  const externalize = async (url: string): Promise<string> => {
    const cached = urls.get(url)
    if (cached) return cached
    const response = await fetch(new URL(url, baseUrl))
    if (!response.ok)
      throw new Error(`Could not export texture (${response.status}): ${url.slice(0, 120)}`)
    const blob = await response.blob()
    const path = await addTextureAsset(files, blob)
    urls.set(url, path)
    return path
  }
  for (const image of json.images ?? []) {
    if (typeof image.url === 'string') image.url = await externalize(image.url)
    else if (Array.isArray(image.url)) {
      const paths: string[] = []
      for (const url of image.url) paths.push(await externalize(url as string))
      image.url = paths
    }
    // Native numeric DataTextures stay inline: converting them to raster can lose precision.
  }
  return { json, files }
}

export async function existingFile(directory: FileSystemDirectoryHandle, name: string) {
  try {
    return await directory.getFileHandle(name)
  } catch (error) {
    if (error instanceof Error && error.name === 'NotFoundError') return undefined
    throw error
  }
}

async function writeFile(directory: FileSystemDirectoryHandle, name: string, blob: Blob) {
  const handle = await directory.getFileHandle(name, { create: true })
  const stream = await handle.createWritable()
  try {
    await stream.write(blob)
    await stream.close()
  } catch (error) {
    await stream.abort().catch(() => {})
    throw error
  }
}

export async function writeFolderAssets(
  directory: FileSystemDirectoryHandle,
  files: ReadonlyMap<string, Blob>,
): Promise<void> {
  if (files.size) {
    const assets = await directory.getDirectoryHandle('assets', { create: true })
    const folders = new Map<string, FileSystemDirectoryHandle>()
    for (const [path, blob] of files) {
      if (
        !/^assets\/(?:textures\/[a-z0-9-]+\.(?:png|jpg|webp|gif)|meshes\/[a-z0-9-]+\.json)$/.test(
          path,
        )
      )
        throw new Error('Invalid project asset path.')
      const folder = path.split('/')[1]!
      let directory = folders.get(folder)
      if (!directory) {
        directory = await assets.getDirectoryHandle(folder, { create: true })
        folders.set(folder, directory)
      }
      const name = path.split('/').at(-1)!
      const existing = await existingFile(directory, name)
      if (existing) {
        if (!(await sameContents(await existing.getFile(), blob)))
          throw new Error(`Existing asset is corrupted or has conflicting contents: ${name}`)
      } else await writeFile(directory, name, blob)
    }
  }
}

/** Commit JSON last so a failed asset write never replaces a working document. */
export async function writeFolderExport(
  directory: FileSystemDirectoryHandle,
  filename: string,
  bundle: Awaited<ReturnType<typeof prepareFolderExport>>,
): Promise<void> {
  if (!/^[^/\\\u0000-\u001f]+\.json$/i.test(filename)) throw new Error('Invalid export filename.')
  await writeFolderAssets(directory, bundle.files)
  await writeFile(
    directory,
    filename,
    new Blob([JSON.stringify(bundle.json, null, 2)], { type: 'application/json' }),
  )
}

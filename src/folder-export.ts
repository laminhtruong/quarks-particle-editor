import { parseQuarksDocument, type QuarksDocument } from './document.js'

const extensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export async function textureAssetPath(blob: Blob): Promise<string> {
  const extension = extensions[blob.type.split(';')[0]!.trim().toLowerCase()]
  if (!extension || !blob.size)
    throw new Error(
      `Cannot export empty or unsupported texture (${blob.type || 'unknown MIME type'}).`,
    )
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())),
  )
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
  return `assets/textures/${hash}.${extension}`
}

async function sameContents(left: Blob, right: Blob): Promise<boolean> {
  if (left.size !== right.size) return false
  const bytes = new Uint8Array(await left.arrayBuffer())
  const expected = new Uint8Array(await right.arrayBuffer())
  return bytes.every((byte, index) => byte === expected[index])
}

export async function addTextureAsset(files: Map<string, Blob>, blob: Blob): Promise<string> {
  const path = await textureAssetPath(blob)
  const previous = files.get(path)
  if (previous && !(await sameContents(previous, blob)))
    throw new Error(`Texture hash collision: ${path}`)
  files.set(path, blob)
  return path
}

/** Keep native image/texture UUIDs; deduplicate files by their original bytes. */
export async function prepareFolderExport(source: QuarksDocument, baseUrl: string) {
  const json = parseQuarksDocument(structuredClone(source))
  const files = new Map<string, Blob>()
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
    const textures = await assets.getDirectoryHandle('textures', { create: true })
    for (const [path, blob] of files) {
      if (!/^assets\/textures\/[a-z0-9-]+\.(png|jpg|webp|gif)$/.test(path))
        throw new Error('Invalid texture asset path.')
      const name = path.split('/').at(-1)!
      const existing = await existingFile(textures, name)
      if (existing) {
        if (!(await sameContents(await existing.getFile(), blob)))
          throw new Error(`Existing asset is corrupted or has conflicting contents: ${name}`)
      } else await writeFile(textures, name, blob)
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

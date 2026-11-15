import type { QuarksDocument } from './document.js'

/** Only raster images: SVG and arbitrary data URLs are not local texture inputs. */
export function readTextureFile(file: File): Promise<string> {
  if (!/\.(png|jpe?g|webp|gif)$/i.test(file.name)) {
    return Promise.reject(new Error('Choose a PNG, JPEG, WebP, or GIF texture.'))
  }
  if (!file.size || file.size > 16 * 1024 * 1024) {
    return Promise.reject(new Error('Texture files must be between 1 byte and 16 MB.'))
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`))
    reader.onabort = () => reject(new Error(`Reading ${file.name} was cancelled`))
    reader.onload = () => {
      const url = String(reader.result)
      if (!/^data:image\/(png|jpeg|webp|gif);base64,/i.test(url)) {
        reject(new Error(`${file.name} is not a supported image.`))
        return
      }
      const image = new Image()
      image.onerror = () => reject(new Error(`Could not decode ${file.name}`))
      image.onload = () => {
        if (image.naturalWidth > 8192 || image.naturalHeight > 8192) {
          reject(new Error('Texture dimensions must not exceed 8192 pixels.'))
        } else resolve(url)
      }
      image.src = url
    }
    reader.readAsDataURL(file)
  })
}

/** Match local files by filename; never rewrite remote or embedded images. */
export function resolveLocalTextures(
  json: QuarksDocument,
  textures: ReadonlyMap<string, string>,
): boolean {
  let changed = false
  const resolve = (url: unknown): unknown => {
    if (typeof url !== 'string' || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) return url
    const filename = url.split(/[?#]/)[0]!.split('/').at(-1)!
    let decoded: string
    try {
      decoded = decodeURIComponent(filename)
    } catch {
      return url
    }
    const local = textures.get(decoded)
    if (!local?.startsWith('data:image/')) return url
    changed = true
    return local
  }
  for (const image of json.images ?? []) {
    image.url = Array.isArray(image.url) ? image.url.map(resolve) : resolve(image.url)
  }
  return changed
}

/** Resolve against the selected folder, not the host page or filename-only library. */
export async function resolveFolderTextures(
  json: QuarksDocument,
  files: readonly File[] | FileSystemDirectoryHandle,
) {
  const local = new Map(
    Array.isArray(files)
      ? files.map((file) => [file.webkitRelativePath.split('/').slice(1).join('/'), file])
      : [],
  )
  await resolveTexturePaths(json, async (path) => {
    let file = local.get(path)
    if (!Array.isArray(files)) {
      let directory = files as FileSystemDirectoryHandle
      const parts = path.split('/')
      for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part)
      file = await (await directory.getFileHandle(parts.at(-1)!)).getFile()
    }
    if (!file) throw new Error(`Missing texture in selected folder: ${path}`)
    return readTextureFile(file)
  })
}

/** Share exact project-relative URL semantics for folders and ZIP imports. */
export async function resolveTexturePaths(
  json: QuarksDocument,
  read: (path: string) => Promise<string>,
) {
  const loaded = new Map<string, string>()
  const resolve = async (url: string): Promise<string> => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) return url
    const path = decodeURIComponent(new URL(url, 'https://folder.invalid/').pathname.slice(1))
    const cached = loaded.get(path)
    if (cached) return cached
    const data = await read(path)
    loaded.set(path, data)
    return data
  }
  for (const image of json.images ?? []) {
    if (typeof image.url === 'string') image.url = await resolve(image.url)
    else if (Array.isArray(image.url)) {
      const urls: string[] = []
      for (const url of image.url) urls.push(await resolve(url as string))
      image.url = urls
    }
  }
}

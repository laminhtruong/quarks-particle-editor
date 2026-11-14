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

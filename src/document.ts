import { z } from 'zod'

const record = z.record(z.string(), z.unknown())

export const textureUrlSchema = z
  .string()
  .min(1)
  .refine((value) => {
    if (/[\\\u0000-\u001f\u007f]/.test(value)) return false
    if (value.startsWith('data:image/')) return true
    try {
      const url = new URL(value, 'https://project.invalid/')
      return url.protocol === 'https:' || url.protocol === 'http:'
    } catch {
      return false
    }
  }, 'texture must use an image data URL, a relative URL, or HTTP(S)')

export const quarksDocumentSchema = z
  .object({
    metadata: z.object({ version: z.number(), type: z.literal('Object') }).passthrough(),
    object: z.object({ type: z.string(), children: z.array(z.unknown()).optional() }).passthrough(),
    images: z.array(record).optional(),
  })
  .passthrough()
  .superRefine((document, context) => {
    if (document.object.type !== 'Group' && document.object.type !== 'Scene') {
      context.addIssue({
        code: 'custom',
        path: ['object', 'type'],
        message: 'root must be a Three.js Group or Scene',
      })
    }
    const hasEmitter = (node: unknown): boolean => {
      if (!node || typeof node !== 'object') return false
      const object = node as Record<string, unknown>
      return (
        object.type === 'ParticleEmitter' ||
        (Array.isArray(object.children) && object.children.some(hasEmitter))
      )
    }
    if (!hasEmitter(document.object)) {
      context.addIssue({
        code: 'custom',
        path: ['object', 'children'],
        message: 'document must contain a Quarks ParticleEmitter',
      })
    }
    for (const [index, image] of (document.images ?? []).entries()) {
      const url = image.url
      const dataTexture =
        url !== null &&
        typeof url === 'object' &&
        Array.isArray((url as Record<string, unknown>).data) &&
        Number.isInteger((url as Record<string, unknown>).width) &&
        Number((url as Record<string, unknown>).width) > 0 &&
        Number.isInteger((url as Record<string, unknown>).height) &&
        Number((url as Record<string, unknown>).height) > 0 &&
        typeof (url as Record<string, unknown>).type === 'string'
      const safeUrl = (value: unknown): boolean => textureUrlSchema.safeParse(value).success
      if (!dataTexture && !(Array.isArray(url) ? url.every(safeUrl) : safeUrl(url))) {
        context.addIssue({
          code: 'custom',
          path: ['images', index, 'url'],
          message: 'texture must be embedded or use a relative URL/HTTP(S) URL',
        })
      }
    }
  })

export type QuarksDocument = z.infer<typeof quarksDocumentSchema>

export function parseQuarksDocument(value: unknown): QuarksDocument {
  return quarksDocumentSchema.parse(value)
}

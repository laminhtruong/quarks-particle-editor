import { meshGeometrySchema, meshReferenceSchema, type QuarksDocument } from './document.js'

export async function readMeshJson(blob: Blob): Promise<unknown> {
  if (!blob.size || blob.size > 64 * 1024 * 1024)
    throw new Error('Mesh JSON files must be between 1 byte and 64 MB.')
  return JSON.parse(await blob.text())
}

/** Hydrate native geometry before preview/editing; keep each reference's UUID and name. */
export async function resolveMeshAssets(
  json: QuarksDocument,
  read: (path: string) => Promise<unknown>,
): Promise<void> {
  if (!json.geometries) return
  const loaded = new Map<string, Promise<ReturnType<typeof meshGeometrySchema.parse>>>()
  const geometries = await Promise.all(
    (json.geometries as Record<string, unknown>[]).map(async (geometry) => {
      if (geometry.url === undefined) return geometry
      const { url, ...reference } = meshReferenceSchema.parse(geometry)
      if (geometry.data !== undefined)
        throw new Error('A mesh cannot contain both inline data and an external URL.')
      let asset = loaded.get(url)
      if (!asset) {
        asset = read(url).then((value) => {
          const payload = meshGeometrySchema.parse(value)
          if (payload.url !== undefined)
            throw new Error('Nested external mesh references are not supported.')
          return payload
        })
        loaded.set(url, asset)
      }
      const payload = await asset
      if (payload.type !== reference.type)
        throw new Error(`Mesh type does not match its reference: ${url}`)
      return { ...structuredClone(payload), ...reference }
    }),
  )
  json.geometries = geometries
}

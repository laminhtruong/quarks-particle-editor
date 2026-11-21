import { FileLoader, LoaderUtils, type LoadingManager, type Object3D } from 'three'
import { QuarksLoader } from 'three.quarks'
import { parseQuarksDocument } from './document.js'
import { readMeshJson, resolveMeshAssets } from './mesh-assets.js'
import { loadUnityPlugin } from './unity-behaviors.js'

export { resolveMeshAssets } from './mesh-assets.js'
export { loadUnityPlugin } from './unity-behaviors.js'

// Effects converted from Unity can use behaviors that Quarks does not ship.
loadUnityPlugin()

/** Resolve external geometry before handing the native document to Quarks. */
export async function loadProjectEffect(url: string, manager?: LoadingManager): Promise<Object3D> {
  const files = new FileLoader<unknown>(manager).setResponseType('json')
  const json = parseQuarksDocument(await files.loadAsync(url))
  const base = LoaderUtils.extractUrlBase(url)
  const meshes = new FileLoader<Blob>(manager).setResponseType('blob').setPath(base)
  await resolveMeshAssets(json, async (path) => readMeshJson(await meshes.loadAsync(path)))
  const loader = new QuarksLoader(manager).setResourcePath(base)
  const object = await loader.parseAsync(json)
  // Upstream Quarks only links sub-emitter references in its synchronous parse().
  loader.linkReference(object)
  return object
}

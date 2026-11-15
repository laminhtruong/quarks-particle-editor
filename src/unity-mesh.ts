import * as THREE from 'three'

/** Read geometry only: model textures/materials never override the Unity particle material. */
export async function readUnityMesh(
  data: Uint8Array<ArrayBuffer>,
  path: string,
  name: string | undefined,
  scale: number,
  useFileScale: boolean,
): Promise<THREE.BufferGeometry> {
  if (data.length > 16 * 1024 * 1024) throw new Error('Mesh source exceeds 16 MB.')
  if (!/\.(fbx|obj)$/i.test(path)) throw new Error('Only FBX and OBJ mesh sources are supported.')
  if (!(scale > 0) || !Number.isFinite(scale)) throw new Error('Invalid model import scale.')
  const manager = new THREE.LoadingManager()
  const ignoredTextures: THREE.Texture[] = []
  const textureLoader = new THREE.TextureLoader(manager)
  // FBXLoader consults handlers before TextureLoader: block all external and embedded image loads.
  textureLoader.load = (url) => {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url)
    const texture = new THREE.Texture<HTMLImageElement>()
    ignoredTextures.push(texture)
    return texture
  }
  manager.addHandler(/.*/, textureLoader)
  let model: THREE.Group | undefined
  let result: THREE.BufferGeometry | undefined
  try {
    const fbx = /\.fbx$/i.test(path)
    model = fbx
      ? new (await import('three/examples/jsm/loaders/FBXLoader.js')).FBXLoader(manager).parse(
          data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
          '',
        )
      : new (await import('three/examples/jsm/loaders/OBJLoader.js')).OBJLoader(manager).parse(
          new TextDecoder('utf-8', { fatal: true }).decode(data),
        )
    const meshes: THREE.Mesh[] = []
    model.traverse((node) => {
      if (node instanceof THREE.Mesh) meshes.push(node)
    })
    const matches = name
      ? meshes.filter(
          (mesh) =>
            mesh.name === name ||
            mesh.userData.originalName === name ||
            mesh.geometry.name === name,
        )
      : meshes
    if (matches.length !== 1)
      throw new Error(`Cannot uniquely resolve mesh ${name ?? '(missing fileID/name mapping)'}.`)
    const mesh = matches[0]!
    if (mesh instanceof THREE.SkinnedMesh || Object.keys(mesh.geometry.morphAttributes).length)
      throw new Error('Skinned and blend-shape meshes are not supported.')
    const position = mesh.geometry.getAttribute('position')
    const indices = mesh.geometry.getIndex()
    if (
      !position ||
      position.itemSize !== 3 ||
      !position.count ||
      position.count > 1_000_000 ||
      (indices?.count ?? position.count) > 3_000_000 ||
      (indices?.count ?? position.count) % 3 !== 0
    )
      throw new Error('Invalid mesh or mesh exceeds 1,000,000 vertices / 1,000,000 triangles.')
    for (const attribute of Object.values(mesh.geometry.attributes)) {
      if (attribute.count !== position.count || !attribute.array.every(Number.isFinite))
        throw new Error('Mesh contains invalid vertex attributes.')
    }
    if (indices && indices.array.some((index) => index < 0 || index >= position.count))
      throw new Error('Mesh contains out-of-range triangle indices.')
    const units = fbx && useFileScale ? Number(model.userData.unitScaleFactor ?? 1) / 100 : 1
    if (!(units > 0) || !Number.isFinite(units)) throw new Error('Invalid FBX file units.')
    // Mesh references exclude model-node transforms; FBXLoader already bakes geometric transforms.
    result = mesh.geometry.clone()
    result.name = name ?? mesh.name
    result.scale(scale * units, scale * units, scale * units)
    result.clearGroups()
    if (!result.hasAttribute('normal')) result.computeVertexNormals()
    if (!result.hasAttribute('uv'))
      result.setAttribute(
        'uv',
        new THREE.Float32BufferAttribute(new Float32Array(position.count * 2), 2),
      )
    result.computeBoundingBox()
    if (
      ![...result.boundingBox!.min.toArray(), ...result.boundingBox!.max.toArray()].every(
        Number.isFinite,
      )
    )
      throw new Error('Mesh scale produced non-finite vertices.')
    return result
  } catch (error) {
    result?.dispose()
    throw error
  } finally {
    model?.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return
      node.geometry.dispose()
      for (const material of Array.isArray(node.material) ? node.material : [node.material])
        material.dispose()
    })
    for (const texture of ignoredTextures) texture.dispose()
  }
}

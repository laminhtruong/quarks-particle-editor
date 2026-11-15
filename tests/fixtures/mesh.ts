import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  MeshBasicMaterial,
  Uint16BufferAttribute,
  Uint8BufferAttribute,
} from 'three'
import { MeshSurfaceEmitter, ParticleSystem, RenderMode } from 'three.quarks'
import { parseQuarksDocument } from '../../src/document'

export function meshEffect(name = 'mesh', surface = false) {
  const geometry = new BufferGeometry()
  geometry.name = name
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute([0, 0, 0, 1.123456789, 0, 0, 0, 1, 0], 3),
  )
  geometry.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3))
  geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2))
  geometry.setAttribute(
    'color',
    new Uint8BufferAttribute([255, 0, 0, 0, 255, 0, 0, 0, 255], 3, true),
  )
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Uint16Array(12), 4))
  geometry.setAttribute(
    'skinWeight',
    new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4),
  )
  geometry.setIndex([0, 1, 2])
  geometry.addGroup(0, 3, 0)
  geometry.computeBoundingSphere()
  geometry.morphAttributes.position = [new Float32BufferAttribute([0, 0, 0, 2, 0, 0, 0, 2, 0], 3)]
  geometry.morphTargetsRelative = true
  const group = new Group()
  group.name = name
  const system = new ParticleSystem({
    material: new MeshBasicMaterial(),
    renderMode: surface ? RenderMode.BillBoard : RenderMode.Mesh,
    instancingGeometry: geometry,
    autoDestroy: false,
    ...(surface ? { shape: new MeshSurfaceEmitter(geometry) } : {}),
  })
  group.add(system.emitter)
  const json = parseQuarksDocument(group.toJSON())
  if (surface) {
    const ps = (json.object.children![0] as { ps: { shape: Record<string, unknown> } }).ps
    ps.shape.geometry = geometry.uuid
  }
  return { id: name, json, geometry, system }
}

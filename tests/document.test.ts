import { describe, expect, it } from 'vitest'
import { quarksDocumentSchema, textureUrlSchema } from '../src/document'
import { intervalBounds, updateParticlePreview } from '../src/preview'
import { BatchedRenderer, ConstantValue, IntervalValue, ParticleSystem } from 'three.quarks'
import { Group, MeshBasicMaterial, Scene } from 'three'

describe('portable effect documents', () => {
  it.each([
    'textures/a.webp',
    '../sprites/a.jpg',
    '/project/a.png',
    'https://cdn.test/a.png',
    'http://localhost:3000/a.png',
    'data:image/png;base64,AA==',
  ])('accepts project texture URL %s', (url) =>
    expect(textureUrlSchema.safeParse(url).success).toBe(true),
  )
  it.each([
    'javascript:alert(1)',
    'file:///private/image.png',
    'data:text/html,<script>',
    'java\nscript:alert(1)',
    '',
  ])('rejects unsafe texture URL %s', (url) =>
    expect(textureUrlSchema.safeParse(url).success).toBe(false),
  )
  it('requires an emitter in imported documents', () => {
    expect(
      quarksDocumentSchema.safeParse({
        metadata: { version: 4.7, type: 'Object' },
        object: { type: 'Group', children: [] },
      }).success,
    ).toBe(false)
  })
  it('reads live generator bounds', () => {
    expect(intervalBounds(new IntervalValue(1, 2), [0, 0])).toEqual([1, 2])
    expect(intervalBounds(new ConstantValue(3), [0, 0])).toEqual([3, 3])
  })
  it('preserves authored emitters during preview and restores autoDestroy', () => {
    const scene = new Scene()
    const group = new Group()
    const batch = new BatchedRenderer()
    const material = new MeshBasicMaterial()
    const system = new ParticleSystem({
      material,
      duration: 0.01,
      looping: false,
      autoDestroy: true,
      startLife: new ConstantValue(0.01),
    })
    group.add(system.emitter)
    scene.add(group, batch)
    batch.addSystem(system)
    for (let i = 0; i < 10; i++) updateParticlePreview(batch, [system], 1 / 60)
    expect(group.children).toHaveLength(1)
    expect(system.autoDestroy).toBe(true)
    system.dispose()
    material.dispose()
  })
})

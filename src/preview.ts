import type { BatchedRenderer, ParticleSystem } from 'three.quarks'
import { ConstantValue, IntervalValue, PiecewiseBezier } from 'three.quarks'

export function intervalBounds(generator: unknown, fallback: [number, number]): [number, number] {
  if (generator instanceof IntervalValue) return [generator.a, generator.b]
  if (generator instanceof ConstantValue) return [generator.value, generator.value]
  return fallback
}

export function particlePreviewDuration(systems: readonly ParticleSystem[]): number {
  const duration = (system: ParticleSystem, ancestors: Set<ParticleSystem>): number => {
    if (ancestors.has(system)) return 0
    const next = new Set(ancestors).add(system)
    const life =
      system.startLife instanceof PiecewiseBezier
        ? Math.max(0, ...system.startLife.functions.flatMap(([curve]) => curve.p))
        : intervalBounds(system.startLife, [0, 0])[1]
    const children = system.behaviors.flatMap((behavior) => {
      if (behavior.type !== 'EmitSubParticleSystem') return []
      const child = (behavior as unknown as { subParticleSystem?: { system: ParticleSystem } })
        .subParticleSystem?.system
      return child && systems.includes(child) ? [duration(child, next)] : []
    })
    return system.duration + Math.max(0, life) + Math.max(0, ...children)
  }
  const roots = systems.filter((system) => !system.onlyUsedByOther)
  return Math.max(
    0.25,
    ...roots.map((system) => (system.looping ? system.duration : duration(system, new Set()))),
  )
}

export function updateParticlePreview(
  batch: BatchedRenderer,
  systems: readonly ParticleSystem[],
  delta: number,
): void {
  // Restart/export serializes this group, so preview must not delete authored emitters.
  const disposable = systems.filter((system) => system.autoDestroy)
  for (const system of disposable) system.autoDestroy = false
  try {
    batch.update(delta)
  } finally {
    for (const system of disposable) system.autoDestroy = true
  }
}

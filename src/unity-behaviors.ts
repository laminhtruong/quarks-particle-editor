import {
  EmitSubParticleSystem,
  Gradient,
  SubParticleEmitMode,
  TrailParticle,
  Vector4,
  loadPlugin,
} from 'three.quarks'
import type { Behavior, FunctionJSON, Particle, Plugin } from 'three.quarks'

/**
 * Unity's "Random Color" start color: each particle takes the gradient's color at a random point,
 * which no native Quarks color generator expresses (they sample gradients by emission time).
 */
export class RandomColorFromGradient implements Behavior {
  type = 'RandomColorFromGradient'

  constructor(public gradient: Gradient) {}

  initialize(particle: Particle) {
    this.gradient.genColor(particle.memory, particle.startColor, Math.random())
    particle.color.copy(particle.startColor)
  }
  update() {}
  frameUpdate() {}
  toJSON() {
    return { type: this.type, gradient: this.gradient.toJSON() }
  }
  static fromJSON(json: { gradient: FunctionJSON }) {
    return new RandomColorFromGradient(Gradient.fromJSON(json.gradient))
  }
  clone() {
    return new RandomColorFromGradient(this.gradient.clone() as Gradient)
  }
  reset() {}
}

type TrailPoint = { color: Vector4; base?: Vector4 }

/**
 * Unity's Trails "Color over Trail": multiplies each trail point's color by the gradient along the
 * trail, from 0 at the particle to 1 at the trail's end. Quarks only records a color per point.
 */
export class ColorOverTrail implements Behavior {
  type = 'ColorOverTrail'
  private readonly tint = new Vector4()

  constructor(public color: Gradient) {}

  initialize() {}
  update(particle: Particle) {
    if (!(particle instanceof TrailParticle)) return
    const points = particle.previous.values() as IterableIterator<TrailPoint>
    const count = particle.previous.length
    let index = 0
    for (const point of points) {
      point.base ??= point.color.clone()
      this.color.genColor([], this.tint, (count - index++) / particle.length)
      point.color.copy(point.base).multiply(this.tint)
    }
  }
  frameUpdate() {}
  toJSON() {
    return { type: this.type, color: this.color.toJSON() }
  }
  static fromJSON(json: { color: FunctionJSON }) {
    return new ColorOverTrail(Gradient.fromJSON(json.color))
  }
  clone() {
    return new ColorOverTrail(this.color.clone() as Gradient)
  }
  reset() {}
}

/**
 * Quarks keeps a Death sub-emission following its parent particle object, which its pool reuses for
 * the next particle, so the emission travels with an unrelated particle. Unity emits where the
 * particle died: detach Death emissions from the particle.
 */
function detachDeathEmissions() {
  const prototype = EmitSubParticleSystem.prototype as unknown as {
    emit(particle: Particle, delta: number): void
    unityDeathFix?: boolean
  }
  if (prototype.unityDeathFix) return
  prototype.unityDeathFix = true
  const emit = prototype.emit
  prototype.emit = function (this: EmitSubParticleSystem, particle, delta) {
    const emissions = (this as unknown as { subEmissions: { particle?: Particle }[] }).subEmissions
    const before = emissions.length
    emit.call(this, particle, delta)
    if (this.mode === SubParticleEmitMode.Death)
      for (let i = before; i < emissions.length; i++) emissions[i]!.particle = undefined
  }
}

/** Behaviors that Unity imports may emit; register them before loading such effects. */
export const unityPlugin: Plugin = {
  id: 'quarks-particle-editor/unity',
  initialize: detachDeathEmissions,
  emitterShapes: [],
  behaviors: [
    {
      type: 'RandomColorFromGradient',
      constructor: RandomColorFromGradient,
      params: [['gradient', ['colorFunc']]],
      loadJSON: RandomColorFromGradient.fromJSON,
    },
    {
      type: 'ColorOverTrail',
      constructor: ColorOverTrail,
      params: [['color', ['colorFunc']]],
      loadJSON: ColorOverTrail.fromJSON,
    },
  ],
}

export function loadUnityPlugin() {
  loadPlugin(unityPlugin)
}

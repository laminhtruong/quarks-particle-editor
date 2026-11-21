# Quarks support matrix

Target: `three.quarks` **0.17.1**, including its bundled `quarks.core` and
automatically registered mesh-surface plugin. The editor does not modify these
packages, add a particle runtime, or change the native effect format.

The inspector uses the installed behavior/shape registries and native `toJSON()`
values. Tests enumerate those registries, create and round-trip every behavior,
shape, and generator, and simulate every behavior with stock Quarks.

## Main, emission, and transforms

- Duration, looping, prewarm, auto destroy, local/world simulation space, and
  `onlyUsedByOther` (sub-emitter-only systems).
- Start lifetime, speed, size (including XYZ), rotation (including quaternion
  generators), and all start color generators.
- Emission over time/distance with scalar generator modes.
- Any number of bursts: time, count generator, and probability. Quarks 0.17.1 serializes
  cycles/interval but never plays them, so the editor shows them read-only; add bursts
  instead. Bursts are kept sorted by time because the runtime stops at the first future burst.
- Root position/rotation/scale and selected emitter position/rotation/scale.
- Add, duplicate, remove, and reorder emitters. Sub-emitter references are selected
  from the current effect; dangling and cyclic links are rejected.

## Generators: 12 modes

| Family   | Modes                                         | Editing                                                                                         |
| -------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Scalar   | ConstantValue, IntervalValue, PiecewiseBezier | Constant, min/max, visual cubic curve editor with keys, tangent handles, presets, zoom and pan  |
| Color    | ConstantColor, ColorRange, RandomColor        | Color picker plus full numeric channels/alpha; HDR channel values are retained                  |
| Gradient | Gradient, RandomColorBetweenGradient          | Independent color/alpha keys, positions, add/remove keys, both random gradients, color preview  |
| Rotation | AxisAngle, Euler, RandomQuat                  | Axis and angle generators, independent Euler-axis generators and Euler order, random quaternion |
| Vector   | Vector3Function                               | Independent scalar generators for X/Y/Z                                                         |

Dropdowns are limited by their context: a size may be scalar or XYZ; an angular
velocity may require a rotation generator. Native angles use **radians** except
the explicitly degree-labelled root rotation controls.

## Shapes: 9

Point, circle, cone, sphere, hemisphere, donut, rectangle, grid, mesh surface.
All serialized shape parameters are exposed, including arc, thickness, angle,
spread, emission mode, and speed generator where the shape supports them.
Emission modes are Random, Loop, Ping Pong, and Burst.

Mesh-surface emission accepts existing document geometry, generated primitives
(Box, Sphere, Plane, Cone, Cylinder, Torus, Icosahedron), or browsed Three.js
geometry JSON. A Three.js Object JSON containing geometries imports its first
geometry. Non-indexed geometry receives sequential indices. Imports are limited
to 64 MB and one million vertices; positions and indices are checked.

Quarks 0.17.1 writes the mesh-surface reference as `mesh` but reads `geometry`.
The editor normalizes both keys and retains the referenced geometry on export;
no upstream code is patched. Unused geometry/material resources and their
referenced textures are retained so that resource selection does not lose assets.

## Behaviors: all 19 registered types

| Behavior              | Parameters                                                             |
| --------------------- | ---------------------------------------------------------------------- |
| ApplyForce            | Direction, magnitude generator                                         |
| ForceOverLife         | X/Y/Z generators                                                       |
| GravityForce          | Center, magnitude                                                      |
| Noise                 | Frequency, power, position amount, rotation amount generators          |
| TurbulenceField       | Scale, octaves, velocity multiplier, time scale                        |
| ColorOverLife         | Complete color/gradient generator                                      |
| ColorBySpeed          | Color generator, speed range                                           |
| SizeOverLife          | Scalar/XYZ generator                                                   |
| SizeBySpeed           | Scalar/XYZ generator, speed range                                      |
| SpeedOverLife         | Speed generator                                                        |
| LimitSpeedOverLife    | Speed generator, dampen                                                |
| RotationOverLife      | Angular velocity generator                                             |
| RotationBySpeed       | Angular velocity generator, speed range                                |
| Rotation3DOverLife    | Rotation generator                                                     |
| OrbitOverLife         | Orbit speed generator, axis                                            |
| FrameOverLife         | Frame generator                                                        |
| WidthOverLength       | Width generator for trails                                             |
| ChangeEmitDirection   | Angle generator                                                        |
| EmitSubParticleSystem | Target emitter, Death/Birth/Frame trigger, probability, velocity basis |

**Add Module** adds any registered type; duplicate modules are allowed.
Checkboxes enable/disable modules; Up/Down changes execution order; Remove deletes
them. Disabled values and ordering are retained in the emitter's standard
`userData.quarksEditorDisabled` metadata. The runtime's `ps.behaviors` contains
enabled behaviors only. A stock Quarks loader ignores the editor metadata and
plays the enabled configuration normally. Tools that strip userData also strip
disabled authoring settings, but not the active effect.

## Renderer and textures

- Billboard, Stretched Billboard, Mesh, Trail, Horizontal Billboard, Vertical Billboard.
- Native renderer settings: stretched speed/length factors; trail length generator
  and follow-local-origin; instancing geometry, material, render order, layers.
- Soft particles, near/far fade, and a preview depth pass. The consuming game must
  supply its own scene depth texture via `BatchedRenderer.setDepthTexture()`.
- All serialized fields of the selected material and referenced textures, including
  opacity, alpha/depth flags, side, blending, UV offset/repeat/rotation and sampling.
  This does not add material features that the Quarks batch shaders do not support.
- Tile counts, frame blending, start tile generator, FrameOverLife animation.
- Open/save project folders, browse raster textures (copied immediately into
  `assets/textures/` with 16-character content hashes), assign them, and reopen
  effects and unused textures together. Undo/redo use keyboard shortcuts.
- Vertex/index mesh data is externalized as deduplicated `assets/meshes/<hash>.json`
  files, without losing typed attributes or precision. Folder/ZIP imports hydrate
  geometry for editing. Games use `quarks-particle-editor/loader`; stock
  `QuarksLoader` alone does not resolve external mesh URLs. Host callbacks still
  receive native inline geometry; compact parametric primitives stay inline.
- **Effects → Import** adds all effects from a project ZIP or all convertible
  particle prefabs from a UnityPackage. Existing effects are kept; duplicate names
  get numeric suffixes. The import report lists conversion warnings and failures.

## Preview and safety

Play/pause, restart, single step, scrub, orbit, zoom, grid, and frame controls.
Non-looping previews include particle lifetimes and sub-emitter tails. Random
generators are native Quarks randomness: scrub is a re-simulation, not a seeded,
bit-identical replay. Distance emission needs emitter movement in the consuming
scene; changing its rate alone does not move the editor's stationary preview.

Edits are validated and parsed into a temporary native scene before replacing
the live document. Invalid edits leave the previous effect intact. Preview
exceptions pause rendering but leave the inspector and export usable. These
checks are not a sandbox for hostile JSON or an unlimited GPU resource guarantee.

## Deliberate runtime boundary / upstream limitations

- **ApplyCollision:** exported by core, but commented out of the stock JSON behavior
  registry; it also requires a host physics resolver. It cannot round-trip through
  an unmodified stock Quarks loader, so the standalone editor does not offer a
  nonfunctional collision module.
- **ApplySequences / TextureSequencer:** runtime classes are exported but not
  registered with the stock behavior loader. They are not standalone JSON modules.
- Custom plugin registration, callbacks, physics resolvers, external scene objects,
  and scripted animation remain responsibilities of the host application.
- Quarks 3D rotation generators affect Mesh rendering; billboard/trail modes do not
  apply quaternion start rotations. WidthOverLength is meaningful for Trail mode.
- Quarks 0.17.1 restores a serialized layer mask of 0 as mask 1. The editor rejects
  mask 0 rather than silently changing it; nonzero masks, including -1, are supported.
- Quarks Noise rotation assumes a rotatable particle. Trail particles do not have
  one; the editor uses a Constant 0 rotation default and rejects nonzero trail
  rotation settings instead of modifying the runtime.
- Unsupported/unregistered behaviors and top-level generators are rejected on
  import, rather than silently disappearing or becoming Constant 0 on re-save.
- Unity-only runtime modules and VFX Graph playback are outside this package.
  `.unitypackage` import offers [best-effort Shuriken conversion](unity-import.md),
  not Unity runtime compatibility or direct standalone prefab import.

No runtime expansion, Unity emulation, or dependency upgrade is required for
any feature listed as supported above.

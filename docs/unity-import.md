# Unity package conversion

The editor imports **one selected prefab per operation** from a `.unitypackage`.
Packages are read locally using browser gzip decompression and a bounded tar
reader. Nothing is extracted onto disk, executed, uploaded, or fetched by the
converter. Dependencies are looked up by Unity GUID, including textures with the
same filename in different folders. Unity's 64-bit fileIDs are preserved exactly.

## Prepare a package

1. Set Unity's **Editor → Asset Serialization → Mode** to **Force Text** and save
   your assets.
2. Prefab variants and nested prefabs are merged from their source prefabs, which
   must be in the package (**Include dependencies**). Property overrides, removed
   components/GameObjects, added objects and the instance's transform parent are
   applied; overrides on unsupported paths are reported. Missing or cyclic source
   prefabs are rejected rather than silently losing inherited systems.
3. Use **Assets → Export Package…**, with **Include dependencies** enabled.
4. Click **Effects → Import** and select the `.unitypackage` (or drop it into the
   editor). All prefabs are processed automatically in one import. Inspect the
   **Import report** for converted effects, warnings, and skipped prefabs.
5. Preview and adjust the effect, then **Save project**. Native Quarks JSON is
   written at the root, textures in `assets/textures/`, and mesh vertex data in
   `assets/meshes/`, shared by content hash. Games use `loadProjectEffect()` from
   `quarks-particle-editor/loader` to resolve mesh assets before Quarks parsing.
   The Unity assets and your original package remain unchanged.

Prefabs without particles and unsupported/broken prefabs are skipped without
blocking valid effects. Duplicate effect names receive numeric suffixes; current
effects and their edits are kept. Images are copied into the selected project
folder immediately, or on the next save if no folder has been selected yet.
The low-level `readUnityPackage().convertPrefab(path)` API still supports converting
an individual prefab; the editor UI uses it for every prefab in the package.

Prefab schemas vary between Unity releases. The importer targets modern
text-serialized Shuriken Particle Systems (`InitialModule`, `EmissionModule`,
etc.), not arbitrary binary Unity assets or VFX Graph.

## Conversion scope

| Unity data                                             | Conversion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GameObject hierarchy, transforms, inactive objects     | Retained, with a Z reflection for handedness; disabled renderers/ancestors hide their emitters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Duration, looping, prewarm, simulation space           | Unity Local/World enum maps directly; custom simulation-space references are not resolved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Fixed start delay on burst emission                    | Constant or midpoint of a random delay. Non-looping: timeline extended, emission gated, bursts and system-time curves shifted. Looping: phase-shifted; the first cycle starts without waiting                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Start life/speed/size, XYZ size, rotation, start color | Native constant/range/curve/color/gradient generators; XYZ start rotation for mesh particles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Gravity modifier                                       | Applied as world-down acceleration using Unity's default -9.81 m/s²; package does not include project-specific physics gravity                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Emission over time/distance and bursts                 | Count, time and probability; Unity cycles/interval (including infinite) are expanded into native bursts, sorted by time, because Quarks 0.17.1 ignores burst cycle/interval. Distance emission needs host movement                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Birth/death sub-emitters                               | Linked by Unity component ID; collision/trigger/manual events and inherited particle properties are not converted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Animation curves                                       | Unweighted Hermite tangents become cubic Bezier control points; weighted tangents are approximated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Random between two curves                              | Two flat curves become an exact random constant; shaped curves use the maximum curve and warn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Color gradients                                        | Independent color and alpha keys; fixed/perceptual interpolation is approximated as linear                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Color over lifetime                                    | Constant/gradient and random color/gradient ranges                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Size over lifetime                                     | Scalar or separate XYZ; random constants stay per-particle random                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Rotation over lifetime                                 | Z angular velocity; mesh particles also support XYZ rotation through native Euler generators                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Force, noise, rotation by speed                        | World-space force is exact. Local-space force is rotated by the static prefab hierarchy (exact for constants, and for curves/randoms under axis-aligned rotations). Noise and speed semantics are approximate                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Limit velocity over lifetime                           | Magnitude limit and dampen; Quarks damping is approximate, separate-axis limits and drag warn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Sphere, hemisphere, cone, circle, donut, rectangle     | Native shapes; Box/Rectangle use a native grid across the area along +Z (box depth dropped with a warning); cone volume is approximated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Shape offsets/rotation/scale, direction modifiers      | Position/rotation applied to the emitter; scale baked into radius/box size (non-uniform uses the largest axis). Direction modifiers are warned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Texture sheet                                          | Whole sheet or a custom single row; constant/random frames become a per-particle start tile; curves with cycles, FPS timing (constant lifetime) and start frame are converted. Speed timing and random rows are approximated                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Billboard, stretched, horizontal/vertical renderer     | Native render modes; stretched length/speed factors and sorting order                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Mesh renderer                                          | FBX/OBJ and built-in Cube/Plane/Quad/Sphere/Cylinder/Capsule; native mesh particles; external vertex data on save; model fileID/name, scale and FBX units                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Render mode None                                       | Hidden emitter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Material                                               | First material. Tint is the property the shader declares (`_BaseColor`/`_TintColor`/`_Color`), not stale saved properties. Blend from `_SrcBlend`/`_DstBlend`/`_BlendOp` or the shader's `Blend` directive, mapped exactly (custom factors included); opaque and `_ALPHATEST_ON`/alpha-clip cutout. Built-in Default-Particle becomes a generated soft sprite. Blend/depth/cull floats are used only when the shader declares them; built-in UI/Default and Mobile/Particles Additive/Alpha Blended use their fixed blending. Without the shader, saved One/Zero floats (stale Standard defaults) fall back to alpha blending with a warning |
| Main texture                                           | `_BaseMap` / `_MainTex`, UV repeat/offset, wrap, point filtering; sampled without sRGB decoding (see below); PNG/JPEG/WebP/GIF externalized on folder export. 8-bit RGB/Grayscale PSD files use their merged composite (as Unity imports it, honoring Remove Matte) and are converted to PNG                                                                                                                                                                                                                                                                                                                                                 |
| Unity shader                                           | Replaced by Quarks unlit material, always reported; custom shader effects/additional maps are not reproduced                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Other enabled modules                                  | Named in warnings, not converted (including velocity/inherited velocity, collision and Unity trail modules)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| UIParticle (ParticleEffectForUGUI)                     | Recognized by its serialized fields (`m_Particles`, `m_Scale3D`). Listed systems are shown although UIParticle disables their `ParticleSystemRenderer`; Transform auto scaling restores the driven scale Unity saves as 0 (`1 / parent lossyScale`). The effect stays in particle units: the canvas scale is reported, not applied                                                                                                                                                                                                                                                                                                           |
| Scripts, Animator/Animation, VFX Graph                 | Not converted; named in warnings when encountered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Colors: the Quarks 0.17.1 unlit particle shader writes fragment colors without output
color-space encoding. Unity colors are therefore used as displayed (gamma) values and
textures are sampled without sRGB decoding, which reproduces Unity's on-screen result
when the effect is rendered directly to the canvas. A host that renders particles into a
linear target followed by an output-encoding pass would need different settings. Quarks
evaluates gradient start colors at absolute system time rather than normalized time; this
upstream behavior is not altered.

Unity's particle caps, scaling/culling semantics, random seeds, project physics
settings and render-pipeline-specific behavior are not reproduced. The import
report is persistent in the UI after conversion and stored in
`object.userData.unityImport` in exported JSON. It is not a lossless Unity backup.
Keep your original package.

The editor preview uses a reference grid without a solid floor or depth writes,
so particles below the grid remain visible. The grid is not included in exports.

Shape handedness uses a reversed emission arc and an emitter half-turn, rather
than negative emitter scale: Quarks 0.17.1 otherwise transforms world-space spawn
positions and velocities inconsistently. Mesh start rotations compensate for
this basis change. These remain stock Quarks shapes and generators on export.
Previously imported JSON keeps its old conversion; reimport the original package
to apply this correction (keep a backup of any edited effects).
Stretched billboards use Quarks' native shader, whose velocity-based elongation
is size-dependent and is not an exact match for Unity's stretch calculation.

Billboard Edge (`SingleSidedEdge`, type 12) emission uses a native one-row grid
across `[-radius, radius]`, with 24-bit position quantization and the emitter basis
rotated so start speed follows Unity's local +Y direction. It stays compatible
with stock Quarks loading, editing and export. Edge traversal modes/spread are
approximated by random sampling with a warning; Edge with mesh rendering remains
unsupported and warns before falling back to point emission.

Mesh import uses Three.js's FBX/OBJ parsers, without loading model textures,
material libraries, or external URLs. The prefab's particle material remains in
use. Old `fileIDToRecycleName` and modern `internalIDToNameTable` metadata select
the mesh; without that mapping, only a model with exactly one mesh is accepted
and a warning is recorded. Multiple renderer meshes use the first mesh only.
Missing, ambiguous, malformed, unsupported, skinned or blend-shape meshes fall
back to a billboard with a warning. Unity's default-resource Cube (1×1×1),
Plane (10×10, XZ), and Quad (1×1, XY) are resolved by their built-in resource
GUID and fileID without requiring a package asset, retaining mesh start rotation
instead of becoming camera-facing billboards. Serialized Unity `.asset` meshes
and other built-in meshes are not yet supported.

Mesh references use geometry, not model-node placement transforms. FBX geometric
transforms are handled by Three.js. Unity axis-import overrides, baked axis
conversion and renderer alignment/pivots are not reproduced exactly; inspect
mesh orientation and scale after importing, especially for non-Y-up source files
or mirrored/non-uniformly scaled hierarchies. This is not a Unity model importer.

## Limits and validation

- Compressed package: **128 MB**; expanded tar: **1024 MB**. Tar entries are read
  sequentially without buffering a second copy of the entire expanded archive;
  asset contents are still retained in memory for prefab conversion.
- Legacy Asset Store pathname records ending in a separate `00` line are accepted;
  other embedded control characters and unsafe paths remain rejected.
- Archive: **40,000 entries**; each entry: **64 MB**. Links, extended tar headers,
  duplicate asset entries/paths and unsafe asset paths are rejected.
- Prefab/material text: **16 MB**, **20,000 serialized objects**; prefab:
  **512 Particle Systems**, transform hierarchy depth **128**.
- Texture: **16 MB**, maximum **8192 × 8192**, decoded using the existing raster
  importer. Unsupported formats are reported rather than loaded remotely.
- Model source: **16 MB**; selected geometry: **1,000,000 vertices / 1,000,000
  triangles**, with finite attributes and valid triangle indices. Missing normals
  are generated and missing UVs become zero UVs. Geometry is shared by repeated
  references and embedded in exported JSON.
- Converted JSON: **64 MB**, so the editor can reopen its export.
- Malformed gzip/tar/YAML, aliases, duplicate fileIDs and missing/cyclic parent
  transforms are rejected. A failed/cancelled import does not replace current edits.

These bounds are not a sandbox or a guaranteed GPU/memory budget. Large packages
and compressed FBX arrays can still consume substantial browser memory before
geometry validation, and extreme emission/prewarm values can make preview
expensive. Review packages from sources you trust.

## Programmatic use

```ts
import { readUnityPackage } from 'quarks-particle-editor'

const unity = await readUnityPackage(file) // browser File, .unitypackage
console.log(unity.prefabs)
const { json, warnings, particleCount } = await unity.convertPrefab(unity.prefabs[0]!)
```

This API returns a native Quarks document without changing an editor instance.
It requires browser file/image APIs and gzip `DecompressionStream` support.

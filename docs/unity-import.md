# Unity package conversion

The editor imports **one selected prefab per operation** from a `.unitypackage`.
Packages are read locally using browser gzip decompression and a bounded tar
reader. Nothing is extracted onto disk, executed, uploaded, or fetched by the
converter. Dependencies are looked up by Unity GUID, including textures with the
same filename in different folders. Unity's 64-bit fileIDs are preserved exactly.

## Prepare a package

1. Set Unity's **Editor → Asset Serialization → Mode** to **Force Text** and save
   your assets.
2. For variants/nested prefabs, make an unpacked copy using **Unpack Prefab
   Completely**. The converter rejects unresolved prefab instances rather than
   silently losing inherited systems or overrides.
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

| Unity data                                               | Conversion                                                                                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| GameObject hierarchy, transforms, inactive objects       | Retained, with a Z reflection for handedness; disabled renderers/ancestors hide their emitters                                    |
| Duration, looping, prewarm, local/world simulation space | Native Quarks parameters; custom simulation-space references are not resolved                                                     |
| Start life/speed/size, XYZ size, rotation, start color   | Native constant/range/curve/color/gradient generators; XYZ start rotation for mesh particles                                      |
| Emission over time/distance and bursts                   | Includes count, time, cycles, interval and probability; distance emission needs host movement                                     |
| Animation curves                                         | Unweighted Hermite tangents become cubic Bezier control points; weighted tangents are approximated                                |
| Random between two curves                                | Uses maximum curve and warns                                                                                                      |
| Color gradients                                          | Independent color and alpha keys; fixed/perceptual interpolation is approximated as linear                                        |
| Color over lifetime                                      | Constant/gradient and random color/gradient ranges                                                                                |
| Size over lifetime                                       | Scalar or separate XYZ; scalar random constants are approximated using the maximum                                                |
| Rotation over lifetime                                   | Z angular velocity; mesh particles also support XYZ rotation through native Euler generators                                      |
| Limit velocity over lifetime                             | Magnitude limit and dampen; Quarks damping is approximate, separate-axis limits and drag warn                                     |
| Sphere, hemisphere, cone, circle, donut, rectangle       | Native shapes where available; distribution may differ; cone volume and boxes are approximated                                    |
| Shape offsets/rotation/scale, direction modifiers        | Warned, not applied independently from emitter transforms                                                                         |
| Texture sheet                                            | Lifetime-based whole-sheet grid; start frame converted to tile index; single row, FPS/speed and cycles are approximated           |
| Billboard, stretched, horizontal/vertical renderer       | Native render modes; stretched length/speed factors and sorting order                                                             |
| Mesh renderer                                            | FBX/OBJ and built-in Cube/Plane/Quad; native mesh particles; external vertex data on save; model fileID/name, scale and FBX units |
| Render mode None                                         | Hidden emitter                                                                                                                    |
| Material                                                 | First material; base/tint color, alpha, alpha clip, depth write, culling, common alpha/additive blending                          |
| Main texture                                             | `_BaseMap` / `_MainTex`, UV repeat/offset, wrap, point filtering, sRGB flag; PNG/JPEG/WebP/GIF externalized on folder export      |
| Unity shader                                             | Replaced by Quarks unlit material, always reported; custom shader effects/additional maps are not reproduced                      |
| Other enabled modules                                    | Named in warnings, not converted (including trails, noise, forces, physics and sub-emitter links)                                 |
| Scripts, Animator/Animation, VFX Graph                   | Not converted; named in warnings when encountered                                                                                 |

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

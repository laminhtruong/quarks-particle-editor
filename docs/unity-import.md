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
4. Import the package, choose a prefab, and inspect the **Unity import report**.
5. Preview and adjust the effect, then download native Quarks JSON. Local textures
   are embedded; the Unity assets and your original files remain unchanged.

Prefab schemas vary between Unity releases. The importer targets modern
text-serialized Shuriken Particle Systems (`InitialModule`, `EmissionModule`,
etc.), not arbitrary binary Unity assets or VFX Graph.

## Conversion scope

| Unity data                                               | Conversion                                                                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| GameObject hierarchy, transforms, inactive objects       | Retained, with a Z reflection for handedness; disabled renderers/ancestors hide their emitters                          |
| Duration, looping, prewarm, local/world simulation space | Native Quarks parameters; custom simulation-space references are not resolved                                           |
| Start life/speed/size, XYZ size, Z rotation, start color | Native constant/range/curve/color/gradient generators                                                                   |
| Emission over time/distance and bursts                   | Includes count, time, cycles, interval and probability; distance emission needs host movement                           |
| Animation curves                                         | Unweighted Hermite tangents become cubic Bezier control points; weighted tangents are approximated                      |
| Random between two curves                                | Uses maximum curve and warns                                                                                            |
| Color gradients                                          | Independent color and alpha keys; fixed/perceptual interpolation is approximated as linear                              |
| Color over lifetime                                      | Constant/gradient and random color/gradient ranges                                                                      |
| Size over lifetime                                       | Scalar or separate XYZ; scalar random constants are approximated using the maximum                                      |
| Rotation over lifetime                                   | Z angular velocity only; separate-axis rotation warns                                                                   |
| Sphere, hemisphere, cone, circle, donut, rectangle       | Native shapes where available; distribution may differ; cone volume and boxes are approximated                          |
| Shape offsets/rotation/scale, direction modifiers        | Warned, not applied independently from emitter transforms                                                               |
| Texture sheet                                            | Lifetime-based whole-sheet grid; start frame converted to tile index; single row, FPS/speed and cycles are approximated |
| Billboard, stretched, horizontal/vertical renderer       | Native render modes; stretched length/speed factors and sorting order                                                   |
| Mesh renderer                                            | Billboard approximation with warning; mesh assets are not imported                                                      |
| Render mode None                                         | Hidden emitter                                                                                                          |
| Material                                                 | First material; base/tint color, alpha, alpha clip, depth write, culling, common alpha/additive blending                |
| Main texture                                             | `_BaseMap` / `_MainTex`, UV repeat/offset, wrap, point filtering, sRGB flag; embedded PNG/JPEG/WebP/GIF                 |
| Unity shader                                             | Replaced by Quarks unlit material, always reported; custom shader effects/additional maps are not reproduced            |
| Other enabled modules                                    | Named in warnings, not converted (including trails, noise, forces, physics and sub-emitter links)                       |
| Scripts, Animator/Animation, VFX Graph                   | Not converted; named in warnings when encountered                                                                       |

Unity's particle caps, scaling/culling semantics, random seeds, project physics
settings and render-pipeline-specific behavior are not reproduced. The import
report is persistent in the UI after conversion and stored in
`object.userData.unityImport` in exported JSON. It is not a lossless Unity backup.
Keep your original package.

## Limits and validation

- Compressed package: **128 MB**; expanded tar: **512 MB**.
- Archive: **40,000 entries**; each entry: **64 MB**. Links, extended tar headers,
  duplicate asset entries/paths and unsafe asset paths are rejected.
- Prefab/material text: **16 MB**, **20,000 serialized objects**; prefab:
  **512 Particle Systems**, transform hierarchy depth **128**.
- Texture: **16 MB**, maximum **8192 × 8192**, decoded using the existing raster
  importer. Unsupported formats are reported rather than loaded remotely.
- Converted JSON: **64 MB**, so the editor can reopen its export.
- Malformed gzip/tar/YAML, aliases, duplicate fileIDs and missing/cyclic parent
  transforms are rejected. A failed/cancelled import does not replace current edits.

These bounds are not a sandbox or a guaranteed GPU/memory budget. Large packages
can still consume substantial browser memory, and extreme emission/prewarm values
can make preview expensive. Review packages from sources you trust.

## Programmatic use

```ts
import { readUnityPackage } from 'quarks-particle-editor'

const unity = await readUnityPackage(file) // browser File, .unitypackage
console.log(unity.prefabs)
const { json, warnings, particleCount } = await unity.convertPrefab(unity.prefabs[0]!)
```

This API returns a native Quarks document without changing an editor instance.
It requires browser file/image APIs and gzip `DecompressionStream` support.

# Quarks Particle Editor

A local-file-first browser editor for native Three.js / `three.quarks` particle
documents, with a Unity-inspired workspace and foldout module inspector.
**Starts empty. No accounts, uploads, or backend required.**
Also available as a framework-independent, embeddable npm package.

Source: [laminhtruong/quarks-particle-editor](https://github.com/laminhtruong/quarks-particle-editor).

## Open your own files

```sh
git clone https://github.com/laminhtruong/quarks-particle-editor.git
cd quarks-particle-editor
npm ci
npm run dev
```

Open the URL printed by Vite:

1. Click **Open JSON** to browse a native Quarks effect, **Import Unity Package**
   to convert a `.unitypackage`, or **New effect** to create one. Standalone Unity
   `.prefab`, `.unity`, and `.vfx` files are not accepted.
2. Click **Import Textures** to select PNG, JPEG, WebP, or GIF files. Select a
   thumbnail in **Project** to assign it to the selected particle system.
3. To resolve a JSON's relative image paths, open JSON and import textures in
   either order; matching is by exact filename including extension. The preview
   refreshes when matching textures arrive. Alternatively, drop one
   JSON and its textures together into the editor. Remote URLs are not rewritten.
4. Edit modules in **Inspector**, then use Play/Pause, Restart, Step, or the
   preview scrubber to check the result.
5. **Download JSON** (Ctrl/Cmd+S) downloads a new file with assigned local textures
   embedded. Reopen it later to continue. The original file is never overwritten.

Files stay in the current browser session; reload loses the session. Download
each changed effect before leaving. No data is uploaded by the editor itself;
JSON with external texture URLs can make network requests to those URLs.
Duplicate texture filenames are rejected instead of silently replacing assets.
Raster files are limited to 16 MB / 8192 pixels per dimension; JSON to 64 MB.

Use the checkboxes in **Hierarchy** to toggle individual Particle Systems in the
preview. Unchecked systems are omitted from **Export JSON**, **Download JSON**,
and **Save to Project**, but remain in the editor so you can re-enable them or
undo the change. Enable at least one system to export; an exported file cannot
restore the omitted systems.

### Import Unity particle prefabs

In Unity, set **Asset Serialization → Force Text**, then export your prefab as a
`.unitypackage` with **Include dependencies** enabled. Click **Import Unity
Package** (or drop the package), choose a prefab, and click **Convert & import**.
Each import converts one prefab, including all its Shuriken Particle Systems and
inactive children. Reopen the package to choose another prefab. Inspect the
persistent **Unity import report**, preview/edit the result, then **Download JSON**.
Supported raster textures are embedded in the native JSON; no Unity installation,
server, or upload is needed during conversion.

The importer maps hierarchy/transforms, main start values, emission rates/bursts,
common shapes, size/color/Z-rotation over lifetime, grid texture-sheet animation,
and basic particle material/tint/blending/UV settings. GUIDs resolve dependencies,
not filenames. Conversion warnings and the source path are also saved in the
root's `userData.unityImport`.

**This is an approximate converter, not Unity playback.** Unity shaders are replaced
with unlit Quarks particle materials. Missing dependencies, unsupported modules,
textures and approximations are reported. Binary prefabs, nested prefabs and
variants are rejected: unpack completely in Unity and re-export as text. VFX Graph,
scripts, animation controllers, mesh assets, trails, physics and sub-emitter links
are not converted. TGA/PSD/EXR and other non-browser image formats need conversion
to PNG before export. See [the exact scope](docs/unity-import.md).

### Reference effects

The optional [demo folder](demo/README.md) contains Fire, Lightning, and Poison
effects from Bug Battle 3D, with separate texture files (not embedded in JSON).
Open a demo JSON and import `demo/textures/*.png` in either order, or drop one
JSON and its texture files together. Demos are never loaded automatically.
**Demo textures are not MIT-licensed; see the [asset notice](demo/ASSETS.md).**

### Familiar particle-authoring layout

- **Hierarchy** selects emitters within an effect.
- **Scene** previews the effect on an orbitable grid.
- **Project** lists opened effects and imported textures.
- **Inspector** uses compact, collapsible **Transform**, **Main**, **Emission**,
  **Shape**, **Renderer**, **Size over Lifetime**, **Color over Lifetime**, and
  **Texture Sheet Animation** sections. Foldout state survives inspector updates.
- Space: play/pause; R: restart; F: frame; Ctrl/Cmd+O: open;
  Ctrl/Cmd+S: download/save; Ctrl/Cmd+Z / Shift+Z: undo/redo.

This is **Unity-inspired, not a Unity clone or compatibility runtime**. It edits
native Quarks behavior; Unity package conversion is best-effort and does not add
Unity-only modules or copied Unity artwork. The inspector exposes all **19 registered behaviors**, **9 registered
shapes**, **12 generator modes**, and **6 render modes** in `three.quarks` 0.17.1.
There are forms for native cubic curve controls, gradient/color/alpha keys,
multiple bursts, vectors, rotations, renderer settings, materials, and textures.
The two quick lifetime editors are optional visual shortcuts; the native forms
in **Behaviors** preserve the complete generators, including cubic control values.

See the [Quarks support matrix](docs/quarks-support.md) for the exact scope and
upstream limitations. This is complete authoring of the stock loader's registered
JSON features, not an implementation of runtime-only host callbacks or Unity APIs.

## Install

This source repository is npm-package-ready; it is not yet published to the npm
registry. To build and install a local package:

```sh
npm ci
npm run check
npm pack
# From the consuming project:
npm install /path/to/quarks-particle-editor-0.3.0.tgz three@^0.187.0 three.quarks@^0.17.1
```

Requires a modern browser with WebGL2 and Shadow DOM. Node.js 22.12+ is needed for
development. Three.js and Quarks are peer dependencies, not bundled copies.

## Empty editor

```ts
import { createParticleEditor } from 'quarks-particle-editor'

const container = document.querySelector<HTMLElement>('#editor')!
const editor = createParticleEditor(container)
await editor.ready

// On unmount (call hasUnsavedChanges() first if you need a navigation prompt):
editor.destroy()
```

Give the container an explicit height, for example `height: 100vh`. Styles are
included inside a Shadow DOM; no global stylesheet import is needed. Multiple
editors can coexist. Keyboard shortcuts apply only inside the focused editor.
Create, open, import textures, and download all work without callbacks. Save
downloads JSON when `saveEffect` is omitted. With a callback it saves through the
host; **Export JSON** still downloads an independent copy.

## Browse your project's data

```ts
import { createParticleEditor } from 'quarks-particle-editor'
import type { ParticleEffect, ParticleTexture } from 'quarks-particle-editor'

// These functions belong to your application, not this package.
declare function readProjectEffects(): Promise<ParticleEffect[]>
declare function readProjectTextures(): Promise<ParticleTexture[]>
declare function writeProjectEffect(id: string, json: ParticleEffect['json']): Promise<void>
declare function removeProjectEffect(id: string): Promise<void>

const editor = createParticleEditor(document.getElementById('editor')!, {
  listEffects: readProjectEffects,
  listTextures: readProjectTextures,
  saveEffect: writeProjectEffect,
  deleteEffect: removeProjectEffect,
})

try {
  await editor.ready
} catch (error) {
  // Loading/validation/WebGL setup failures also appear inside the editor.
  console.error(error)
  editor.destroy()
}
```

| Callback               | Contract                                                                        |
| ---------------------- | ------------------------------------------------------------------------------- |
| `listEffects()`        | Returns `{ id, json, defaultJson? }[]`; called once on mount. Defaults to `[]`. |
| `listTextures()`       | Returns `{ id, url }[]`; called once on mount. Defaults to `[]`.                |
| `saveEffect(id, json)` | Persists the native document; reject on failure. Receives a copy.               |
| `deleteEffect(id)`     | Deletes a saved document; reject on failure. Optional.                          |

Effect and texture ids must be unique within each library. Documents and textures
are validated before initialization. Host-owned input objects are not mutated.
Libraries are snapshots loaded on mount; remount to browse externally changed
data. The package never scans folders or assumes API routes, a bundler, or a
project directory structure. The host can implement callbacks with its dev server,
backend, IndexedDB, or an explicitly user-authorized filesystem API.

`json` is a Three.js `Group` or `Scene` containing at least one Quarks
`ParticleEmitter`. Optional `defaultJson` is a **host-provided** default: it
protects the effect from deletion and enables **Reset to project default**.
For such effects, `deleteEffect` must remove only the override. The editor itself
ships no defaults. User-created effects start with one editable emitter only
after clicking **New effect**.

Texture URLs may be relative, root-relative, HTTP(S), or image data URLs. Relative
URLs resolve against the host page and project-library URLs are preserved on
export. Cross-origin images need CORS headers, including for JSON serialization.
Files without a texture use an untextured material, not a bundled image. The
preview has its own Three.js scene; exported JSON can be loaded into a game's
scene with `QuarksLoader` and `BatchedRenderer`.

`ready` resolves after initialization, not after every external image finishes
loading. `destroy()` is idempotent, cancels animation/timers, disconnects resize
observation, removes unload handling and DOM, and disposes preview resources. It
does not cancel a save/delete already accepted by the host. Callbacks should
finish normally even if the UI is unmounted. Unsaved edits trigger the browser's
page-unload warning; SPA navigation should check `hasUnsavedChanges()` itself.

For validation without importing Three.js or editor UI:

```ts
import { parseQuarksDocument } from 'quarks-particle-editor/document'
```

## Development

```sh
npm ci
npm run dev       # Empty editor demo, deliberately no assets or API
npm run check     # Types, formatting, unit tests, build
npm pack --dry-run
```

The build is ESM JavaScript plus TypeScript declarations. Application consumers
do not need Vite. Run `npm pack` again after changing the package, then reinstall
the resulting tarball in the consuming project. Publishing to npm is a separate,
explicit release operation; no publish credentials or automatic publish job are
included.

## Community and license

See [Contributing](CONTRIBUTING.md), [Code of Conduct](CODE_OF_CONDUCT.md), and
[Security](SECURITY.md). Use GitHub issues for bugs and feature discussions.

Extracted from [Bug Battle 3D](https://github.com/laminhtruong/bug-battle-3d),
[MIT licensed](LICENSE). Not affiliated with Unity Technologies or the Quarks
project. Unity is a trademark of its respective owner. Dependencies retain
their own licenses; no Unity source code, logos, or assets are distributed.

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

1. Click **Open project** (Ctrl/Cmd+O) and choose your project folder. All native
   Quarks JSON files at its root are indexed together. Only the selected effect's
   textures, meshes and runtime are loaded; visited effects stay cached for editing.
   An empty folder works for a new project; use **New effect** to add effects.
2. In **Project → Textures**, click **Browse** to select PNG, JPEG, WebP, or GIF
   files. They are copied immediately into the project’s `assets/textures/` folder,
   even before assignment or saving. If no folder is selected, choose one first,
   then click **Browse** again to choose textures.
   Select a texture to load and assign it to the selected particle system. Unused
   folder thumbnails load automatically as they scroll into view, without assigning
   textures or blocking the preview. Offscreen textures are not decoded up front.
3. In **Effects**, click **Import** to add another project's `.zip` or all effects
   from a `.unitypackage`. You can also drop an archive, one JSON, or textures into the editor.
   Dropped JSON paths match browsed textures by exact filename including extension;
   project folder paths resolve exactly, without basename matching.
4. Edit modules in **Inspector**, then use Play/Pause, Restart, Step, or the
   preview scrubber to check the result.
5. **Save project** (Ctrl/Cmd+S) saves all effects into the selected folder without
   asking again. With no folder selected, the first save asks for one. Effect JSON
   goes at its root; images go in `assets/textures/`, mesh data in `assets/meshes/`. Undo/Redo use
   Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Ctrl/Cmd+Y), without toolbar buttons.

Opening and importing display a persistent progress overlay with the current phase
and file counts where known. Folder JSON is checked when indexed; missing/corrupt
assets and runtime incompatibilities are reported when their effect is selected,
without replacing the current effect or its edits. Saving leaves unopened effect
files and their assets untouched. Archive imports still process all effects before
adding them to the session; save and reopen the folder for on-demand asset loading.

Unsaved edits stay in the current browser session; reload loses them. Save the
project before leaving, then reopen its folder after reloading. Switching effects
within an open project preserves pending edits. No data is uploaded by the editor itself;
JSON with external texture URLs can make network requests to those URLs.
Duplicate texture filenames are rejected instead of silently replacing assets.
Raster files are limited to 16 MB / 8192 pixels per dimension; JSON to 64 MB.

Use the checkboxes in **Hierarchy** to toggle individual Particle Systems in the
preview. **Save project** preserves unchecked systems and their native visibility
flags so reopening the project does not lose editable data. The host `saveEffect`
callback retains its existing enabled-systems-only contract and requires at least
one enabled system.

### Import Unity particle prefabs

In Unity, set **Asset Serialization → Force Text**, then export your prefab as a
`.unitypackage` with **Include dependencies** enabled. Click **Effects → Import**
and select the package, or drop it into the editor. Every prefab is processed in
one operation, including its Shuriken Particle Systems and inactive children.
Prefabs without particles or with unsupported data are skipped with reasons;
valid effects still import. Inspect the persistent **Import report**, preview/edit
the results, then **Save project**. Name collisions get numeric suffixes instead
of replacing existing effects or discarding their edits.
Supported raster textures are held locally during editing and written as separate
files on folder export; no Unity installation, server, or upload is needed during
conversion.

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

### Import another project ZIP

Zip the project folder containing root-level effect JSON and its texture files.
**Effects → Import** accepts JSON at the archive root or within one enclosing
folder. Texture paths resolve exactly relative to that project root. All effects
are added to the current project; existing effects are kept, with numeric suffixes
for duplicate names. The source ZIP is never modified.

Referenced images and unused raster textures join the texture library, sharing
short content-hashed files. If a project folder is already selected, imported
images are copied there immediately; otherwise they are written on **Save project**.
External mesh references are also resolved from the ZIP before editing; missing
or malformed mesh files abort the import. Effect JSON is written only on save. Missing or corrupt images and invalid JSON
abort ZIP decoding without replacing the current session. Native runtime-incompatible
effects are skipped with a reason in **Import report**.

ZIP import accepts standard stored/Deflate archives up to 128 MB compressed,
512 MB expanded, 64 MB per entry, and 40,000 entries. Normal texture/JSON limits
also apply. Encrypted, multi-volume, and ZIP64 archives are not supported. Archive
paths containing traversal or duplicate entries are rejected, not extracted.

### Reference effects

The optional [demo folder](demo/README.md) contains Fire, Lightning, and Poison
effects from Bug Battle 3D, with separate texture files (not embedded in JSON).
Copy that folder and use **Open project**, or drop one JSON and its texture files
together. Demos are never loaded automatically.
**Demo textures are not MIT-licensed; see the [asset notice](demo/ASSETS.md).**

### Familiar particle-authoring layout

- **Hierarchy** selects emitters within an effect.
- **Scene** previews the effect on an orbitable grid.
- **Project** lists opened effects and imported textures.
- **Inspector** uses compact, collapsible **Transform**, **Main**, **Emission**,
  **Shape**, **Renderer**, **Size over Lifetime**, **Color over Lifetime**, and
  **Texture Sheet Animation** sections. Foldout state survives inspector updates.
- **Color and gradient pickers** offer a hue wheel, saturation/brightness square,
  RGBA sliders, hex input, transparency previews, and draggable color/alpha keys.
  Changes stay in a draft until **Apply**; **Cancel** or Escape discards them.
- **Curve editor** opens from any curve preview: drag keys and tangent handles,
  double-click to add keys, choose presets or Smooth/Linear/Flat tangents, and
  zoom vertically with the wheel (Alt-drag to pan, **Fit** to reset). **Apply**
  commits one undoable edit; **Cancel** or Escape leaves the curve unchanged.
- Space: play/pause; R: restart; F: frame; Ctrl/Cmd+O: open;
  Ctrl/Cmd+S: save; Ctrl/Cmd+Z / Shift+Z: undo/redo.

This is **Unity-inspired, not a Unity clone or compatibility runtime**. It edits
native Quarks behavior; Unity package conversion is best-effort and does not add
Unity-only modules or copied Unity artwork. The inspector exposes all **19 registered behaviors**, **9 registered
shapes**, **12 generator modes**, and **6 render modes** in `three.quarks` 0.17.1.
There are visual editors for native cubic curves and gradient/color/alpha keys, plus forms for
multiple bursts, vectors, rotations, renderer settings, materials, and textures.
Lifetime sections and **Behaviors** share the same curve and gradient editors,
preserving the complete generators, including cubic control values.

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
Create, open, browse textures, and save project all work without callbacks. With
`saveEffect`, saving uses the host’s existing native JSON contract until a local
project folder is selected. Opening a folder replaces the host-provided library
for this session; subsequent saves target that folder, not the host callback.

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
data. The package only scans a local folder after explicit user selection and
never assumes API routes or a bundler. The host can implement callbacks with its dev server,
backend, IndexedDB, or an explicitly user-authorized filesystem API.

`json` is a Three.js `Group` or `Scene` containing at least one Quarks
`ParticleEmitter`. Optional `defaultJson` is a **host-provided** default: it
protects the effect from deletion and enables **Reset to project default**.
For such effects, `deleteEffect` must remove only the override. The editor itself
ships no defaults. User-created effects start with one editable emitter only
after clicking **New effect**.

Texture URLs may be relative, root-relative, HTTP(S), or image data URLs. Relative
URLs resolve against the host page during editing. Folder export copies images
from these URLs into the output; cross-origin images need CORS headers. The
`saveEffect` callback retains the original native URL/embedded-image and inline-geometry contract.
Files without a texture use an untextured material, not a bundled image. The
preview has its own Three.js scene; exported JSON can be loaded into a game's
scene with `loadProjectEffect()` and `BatchedRenderer`.

### Project layout and game loading

Project folders require Chrome/Edge with the File System Access API on HTTPS or
localhost. Cancelling the picker or a failed write does not mark edits as saved.
Opened project JSON files are updated in place; overwriting a file not already
owned by the session requires confirmation. All texture/mesh assets are written before effect JSON.
Each file write is atomic, but saving several JSON files is not one transaction:
a failure can leave some documents updated, with the project still marked unsaved.

```text
effects/
  fire.json
  smoke.json
  assets/textures/
    2cf24dba5fb0a30e.png
    42b7c9ea8a14d250.webp
  assets/meshes/
    6c1bf5f8b3f00525.json
```

Image URLs in JSON are relative to that JSON, e.g.
`assets/textures/2cf24dba5fb0a30e.png`. Names use the first 16 hex characters of
SHA-256 instead of 64; matching names are checked byte-for-byte, and conflicting
content aborts the operation without overwriting the asset. PNG/JPEG/WebP/GIF bytes are preserved, not
re-encoded. Identical bytes share a content-hashed file across emitters and
effects exported into the same folder; existing matching files are not rewritten.
Old unused assets are not deleted; older 64-character filenames can still be opened.
Deleting an effect in the editor removes its JSON on the next successful save.
Numeric Three.js DataTextures remain inline to preserve precision. BufferGeometry
vertex/index data is stored once in `assets/meshes/<hash>.json`; effect JSON keeps
only the native UUID/type/name and a relative `url` in its `geometries` entries.
Mesh assets preserve indices, typed attributes, normals, UVs, groups, morphs and
skinning data without quantization or conversion to another mesh format. Hashing
ignores geometry UUID/name and JSON key order, so matching payloads share files
across effects. Small parametric primitives remain inline as construction parameters,
not vertex arrays. Older inline-mesh projects still open and migrate on the next save.
Mesh JSON is limited to 64 MB per file. Missing, malformed or conflicting mesh assets
fail the operation instead of falling back to a different shape.
Missing images, HTTP/CORS failures, and unsupported image MIME types stop export
rather than silently producing an incomplete package.

Serve the **whole folder** as static game assets, retaining its structure:

```ts
import { BatchedRenderer, QuarksUtil } from 'three.quarks'
import { loadProjectEffect } from 'quarks-particle-editor/loader'

const batch = new BatchedRenderer()
scene.add(batch)
const effect = await loadProjectEffect('/effects/fire.json')
scene.add(effect)
QuarksUtil.addToBatchRenderer(effect, batch)
// In the game loop: batch.update(deltaSeconds)
```

**Compatibility:** stock `QuarksLoader.load()` does not resolve external geometry.
Use the lightweight `/loader` entry point (no editor UI/CSS) for new saved projects;
it also accepts older inline meshes, resolves textures relative to the JSON URL,
and links sub-emitters after loading. An optional second argument accepts your
Three.js `LoadingManager`.

For a custom fetch pipeline, call `resolveMeshAssets(json, readMeshJson)` from the
same entry point before passing the hydrated native document to `QuarksLoader`.
The callback receives each project-relative mesh URL and returns its parsed JSON;
set the Quarks loader resource path to the effect JSON directory for textures.

External files reduce duplicated storage/transfer, not vertex counts or VRAM by
themselves. There is no permanent global geometry cache; repeated game loads use
your HTTP cache policy and instantiate native geometry for each loaded scene.

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

Set `CHROME_PATH` to a Chrome/Chromium executable to include the real-browser
preview layout regression in `npm test`. It compares full and filtered asset lists
while the same particle simulation runs; without Chrome this test is skipped.

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

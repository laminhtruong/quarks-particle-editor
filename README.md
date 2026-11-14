# Quarks Particle Editor

A framework-independent browser editor for native Three.js / `three.quarks`
particle documents. **No bundled effects, textures, game code, or backend.**
The consuming project supplies its library and persistence callbacks.

## Install

This source repository is npm-package-ready; it is not yet published to the npm
registry. To build and install a local package:

```sh
npm ci
npm run check
npm pack
# From the consuming project:
npm install /path/to/quarks-particle-editor-0.1.0.tgz three@^0.187.0 three.quarks@^0.17.1
```

Requires a modern browser with WebGL2 and Shadow DOM. Node.js 22+ is needed for
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
Create and import work without a backend; use Export JSON to download work.
Save reports that no handler is configured when `saveEffect` is omitted.

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

Extracted from [Bug Battle 3D](https://github.com/laminhtruong/bug-battle-3d),
MIT licensed. Not an official Quarks project.

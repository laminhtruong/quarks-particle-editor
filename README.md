# Quarks Particle Editor

A browser editor for native Three.js / `three.quarks` particle effects. It starts
empty, works with local project files, and can also be embedded in an application.
The editor itself requires no account, backend, or upload.

## Run

```sh
git clone https://github.com/laminhtruong/quarks-particle-editor.git
cd quarks-particle-editor
npm ci
npm run dev
```

Open the URL printed by Vite. Choose **Open project** to edit a folder of effects,
or click **New effect** to start one. Edit and preview in the Inspector, then use
**Save project** (Ctrl/Cmd+S). Unsaved changes are lost on reload. Folder access
requires Chrome or Edge on HTTPS or localhost. The editor does not upload files,
but effects with external image URLs can make browser network requests.

## Build static site

Run `npm run build:web` to create the deployable site in `dist-web/`, configured
for the GitHub Pages path `/quarks-particle-editor/`.

## Files and runtime

The editor saves native Quarks JSON alongside referenced assets:

```text
effects/
  fire.json
  assets/textures/<content-hash>.png
  assets/meshes/<content-hash>.json   # when needed
```

Keep the folder structure when serving effects to a game. Use the package loader
to resolve project-relative textures, external mesh data, and sub-emitter links:

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

Stock `QuarksLoader` does not resolve external mesh files. Older inline-mesh
projects remain supported. See [Bug Battle 3D](https://github.com/laminhtruong/bug-battle-3d)'s
[`public/particles/`](https://github.com/laminhtruong/bug-battle-3d/tree/main/public/particles)
and [integration notes](https://github.com/laminhtruong/bug-battle-3d/blob/main/docs/particle-editor-package.md)
for a working game example.

## Import

- Native Quarks JSON, project ZIPs, or Unity `.unitypackage` files.
- Unity conversion is best-effort Shuriken conversion, not Unity playback. See the
  [conversion scope](docs/unity-import.md).
- The optional [Fire, Lightning, and Poison demos](demo/README.md) are reference
  copies. Their textures are **not covered by the MIT license**; see
  [demo asset terms](demo/ASSETS.md).

The editor supports the registered behaviors, shapes, generators, and render modes
in `three.quarks` 0.17.1. See the [support matrix](docs/quarks-support.md) for
details and upstream limitations.

## Embed

This repository is ready to build as an npm package but is not published to npm.
Create a local tarball with `npm pack`, then install it alongside compatible Three.js
and Quarks versions (`three@^0.187.0`, `three.quarks@^0.17.1`).

```ts
import { createParticleEditor } from 'quarks-particle-editor'

const editor = createParticleEditor(document.querySelector<HTMLElement>('#editor')!)
await editor.ready
// On unmount:
editor.destroy()
```

Give the editor container a height. To load an application-owned library, pass
`listEffects`, `listTextures`, and `saveEffect` callbacks; see their TypeScript
contracts in the package exports. The editor validates inputs and does not mutate
host-owned objects. Host callbacks must reject when saving fails.

## Development and license

```sh
npm ci
npm run check
npm pack --dry-run
```

Node.js 22.12+ is required for development. `npm run check` runs type, format,
test, and build checks. The project is MIT licensed; dependencies and demo textures
retain their own licenses. Extracted from [Bug Battle 3D](https://github.com/laminhtruong/bug-battle-3d);
not affiliated with Unity or Quarks. See [Contributing](CONTRIBUTING.md),
[Security](SECURITY.md), and [LICENSE](LICENSE).

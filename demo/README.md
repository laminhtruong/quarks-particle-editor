# Reference particle effects

Three native Quarks JSON effects copied from
[Bug Battle 3D](https://github.com/laminhtruong/bug-battle-3d)'s `public/particles/`
project, with textures stored as separate PNG files. These are standalone reference
copies; edit the game's project folder to work with its complete current effect set
and assets.

| Demo             | Game source                              | Description                |
| ---------------- | ---------------------------------------- | -------------------------- |
| `Fire.json`      | `public/particles/flame-head.json`       | Continuous flame and smoke |
| `Lightning.json` | `public/particles/lightning-impact.json` | Lightning impact burst     |
| `Poison.json`    | `public/particles/poison-impact.json`    | Poison impact burst        |

## Open in the editor

1. Run `npm ci` and `npm run dev` from the repository root.
2. Copy `demo/` to a separate project folder to keep these reference files intact.
3. Click **Open project** and select that copy. All three effects open with their
   textures; select Fire, Lightning, or Poison from the effect list.
4. Use Play/Restart to inspect the effect. Lightning and Poison are one-shot
   effects; restart to replay them.

Alternatively, drag one JSON and all the PNG files **together** into the editor.
Select files, not the containing folder: folder drag-and-drop is not required.
Local texture resolution matches exact filenames, including extensions.
The editor still starts empty; these examples are not automatically imported.

The checked-in JSON references `textures/<filename>.png`; it contains no base64
images. **Save project** updates JSON in the selected folder and writes textures
into `assets/textures/` with short content-hashed names. Existing unused texture
files remain untouched. **Textures → Browse** copies additional images into that
folder immediately.

## Use in a Three.js project

Keep the JSON files and their relative texture paths on your web server. The game
project uses `assets/textures/`; these standalone demo copies use `textures/`.
With `quarks-particle-editor`, `three`, and `three.quarks` installed:

```ts
import { BatchedRenderer, QuarksUtil } from 'three.quarks'
import { loadProjectEffect } from 'quarks-particle-editor/loader'

const batch = new BatchedRenderer()
scene.add(batch)

// Loads native JSON and resolves project-relative texture/mesh assets.
const effect = await loadProjectEffect('/demo/Fire.json')
scene.add(effect)
QuarksUtil.addToBatchRenderer(effect, batch)

// In your existing render loop, before renderer.render(scene, camera):
batch.update(deltaSeconds)
```

`scene` and `deltaSeconds` above come from your application's existing scene and
render loop. For effects saved by the editor, use `loadProjectEffect()` so external
mesh assets are resolved before Quarks parses the document. It also loads older
inline-mesh effects such as these demos.

## Asset license

**The demo textures are not covered by the editor's MIT license.** Read
[ASSETS.md](ASSETS.md) before reuse or redistribution. Including these reference
files does not grant an Epic Toon FX license.

# Reference particle effects

Three native Quarks JSON effects copied from
[Bug Battle 3D](https://github.com/laminhtruong/bug-battle-3d), with the original
textures stored as separate PNG files. Only image paths have changed; particle,
material, geometry, and texture settings are unchanged.

| Demo             | Game source                                   | Description                |
| ---------------- | --------------------------------------------- | -------------------------- |
| `Fire.json`      | `src/content/particles/flame-head.json`       | Continuous flame and smoke |
| `Lightning.json` | `src/content/particles/lightning-impact.json` | Lightning impact burst     |
| `Poison.json`    | `src/content/particles/poison-impact.json`    | Poison impact burst        |

## Open in the editor

1. Run `npm ci` and `npm run dev` from the repository root.
2. Click **Import Textures** and select all PNG files in `demo/textures/`.
3. Click **Open JSON** and select `Fire.json`, `Lightning.json`, or `Poison.json`.
4. Use Play/Restart to inspect the effect. Lightning and Poison are one-shot
   effects; restart to replay them.

Alternatively, drag one JSON and all the PNG files **together** into the editor.
Select files, not the containing folder: folder drag-and-drop is not required.
Local texture resolution matches exact filenames, including extensions.
The editor still starts empty; these examples are not automatically imported.

The checked-in JSON references `textures/<filename>.png`; it contains no base64
images. Downloading after importing local textures embeds those images, following
the editor's normal portable-download behavior; it does not overwrite these files.

## Use in a Three.js project

Keep the JSON files next to the `textures/` directory on your web server. With
compatible `three` and `three.quarks` installed:

```ts
import { BatchedRenderer, QuarksLoader, QuarksUtil } from 'three.quarks'

const batch = new BatchedRenderer()
scene.add(batch)

// loadAsync resolves relative texture URLs against the JSON's directory.
const effect = await new QuarksLoader().loadAsync('/demo/Fire.json')
scene.add(effect)
QuarksUtil.addToBatchRenderer(effect, batch)

// In your existing render loop, before renderer.render(scene, camera):
batch.update(deltaSeconds)
```

`scene` and `deltaSeconds` above come from your application's existing scene and
render loop. If you fetch JSON yourself and call `parse()` instead of `loadAsync()`,
set the loader's resource path to the JSON directory before parsing.

## Asset license

**The demo textures are not covered by the editor's MIT license.** Read
[ASSETS.md](ASSETS.md) before reuse or redistribution. Including these reference
files does not grant an Epic Toon FX license.

# Contributing

Bug reports, documentation, accessibility improvements, and focused pull requests
are welcome. For larger features, open an issue before implementation.

## Develop

Use Node.js 22.12 or newer:

```sh
npm ci
npm run dev
npm run check
npm pack --dry-run
```

The demo intentionally starts empty. Use your own native Quarks JSON and raster
textures. Never commit proprietary assets, credentials, or generated `dist/`.
Only contribute files you have permission to distribute under MIT.

## Pull requests

- Keep the change focused; use TypeScript strict mode and existing patterns.
- Run `npm run check` (types, formatting, tests, library build).
- Add a regression test for behavior changes. Check the empty-editor workflow,
  file download/reopen, and `destroy()` when changing the UI or lifecycle.
- For UI changes, include before/after screenshots and browser/viewport details.
- Preserve native Quarks JSON and the optional host callback API.
- Keep UI strings, comments, and documentation in English.
- Use Conventional Commits, for example `fix: preserve local textures on export`.

`src/index.ts` owns the UI and preview lifecycle, `src/local-files.ts` handles
local texture validation and filename resolution, and `src/document.ts` is the
engine-free document validation entry point. Styles live in Shadow DOM.

## Releases

Maintainers bump the package version, run checks, inspect `npm pack --dry-run`,
then publish explicitly with their own npm credentials. CI never publishes.
Do not commit tokens or add publish automation to an unrelated change.

By contributing, you agree to the [code of conduct](CODE_OF_CONDUCT.md) and
license your contributions under the repository's [MIT license](LICENSE).

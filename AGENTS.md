# Project rules

## Bug fixes

- Fix the root cause in shared logic, not just the reported example.
- Do not hardcode exceptions for particular effects, asset names, GUIDs, package
  paths, or reproduction files. Format/version compatibility must follow the
  documented format semantics, not the identity of an asset.
- Check all affected callers and import, preview, edit, save/export paths.
- Add regression coverage for the reported failure and a different representative
  case to demonstrate that the fix is general and preserves valid behavior.
- If the root cause is uncertain, investigate or ask for evidence rather than
  disguising the problem with per-case visual or parameter overrides.

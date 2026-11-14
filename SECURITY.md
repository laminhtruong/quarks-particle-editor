# Security

Only the latest release is supported. This is an experimental browser editor,
not a sandbox for hostile files; schema validation is not a full Quarks verifier.

## Reporting a vulnerability

Do not post secrets or exploitation details in a public issue. Use
[GitHub private vulnerability reporting](https://github.com/laminhtruong/quarks-particle-editor/security/advisories/new).
If unavailable, open an issue requesting a private contact without sensitive details.
There is no guaranteed response time or paid security support.

## File and network boundaries

- Local file pickers read only explicitly selected files. They do not scan your disk.
- There is no upload endpoint, telemetry, account service, or automatic persistence.
- Imported JSON can reference remote images: opening it may request those URLs.
  Do not open untrusted documents, and do not place secrets in texture URLs.
- Raster imports are decoded, limited to 16 MB and 8192 pixels per dimension.
  JSON imports are limited to 64 MB. Large documents can still exhaust GPU/memory;
  these are guardrails, not a complete resource sandbox.
- Download creates a new JSON file. It never overwrites the original automatically.
- Embedded textures are part of exported JSON. Share only assets you can distribute.
- Hosts own callback authorization and server-side validation. Never expose a
  filesystem-writing dev server to untrusted users or networks.

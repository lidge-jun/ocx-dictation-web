# Changelog

## 1.0.0 — 2026-10-07

- Added a Node CLI for `start [--port N]`, `paths [--json]`, `doctor`, and copy-verified `migrate [--from DIR] [--dry-run]` to per-user storage.
- Made configuration portable, with configurable endpoint/models, courses, time zone, and ffmpeg tools.
- Hardened the loopback HTTP server with request limits, origin checks, path containment, security headers, and safe errors.
- Prevented duplicate microphone recording across tabs; mirrored recorder state and coordinated notes with revision conflicts.
- Added opt-in Markdown vault export in place of a private wiki integration.
- Added vault path previews and collision responses; overwrite requires confirmation, with backup/rollback on publication errors.
- Added public documentation, privacy scan, and Linux/macOS CI.

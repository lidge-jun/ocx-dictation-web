# Agent guide

This repository is a local Node.js lecture recorder with a Korean browser UI. Read [structure/INDEX.md](structure/INDEX.md) before editing a subsystem.

## Safety

- Never open or modify a user's real `~/.ocx-dictation`, legacy data, endpoint key, or running server during tests. Use an OS temporary directory and fictional fixtures.
- Keep the HTTP server loopback-only. Do not expose the key or filesystem paths through browser APIs, events, or logs.
- Do not add telemetry, runtime dependencies, or a remote-access mode without an explicit product decision.
- Private `devlog/_plan/` and `devlog/_fin/` are local working records and must not enter the public tree. Run the privacy scan and inspect the exact staged tree before publication.

## Checks

`npm run check` checks tracked and pending `.mjs`/`.js` syntax and enforces 120 columns for `server.mjs` and files under `bin/`, `lib/`, `scripts/`, `tests/`, and `public/js/` (lines ending `// long-line-ok` are exempt). `npm test` runs `node --test tests/*.test.mjs`; `npm run privacy` scans public candidates. If a change depends on a browser flow, use a fake endpoint and temporary home. Cite the relevant test and command in the change report.

The CLI supports `start [--port N]`, `paths [--json]`, `doctor`, and `migrate [--from DIR] [--dry-run]`; use the dry run and an empty destination home for migration. Do not infer privacy or browser correctness from syntax checks alone.

## Ownership

`bin/` owns CLI commands; `lib/` owns server services; `server.mjs` composes them; `public/` owns the browser; `tests/` owns fixtures and contracts; `docs/` explains user-visible behavior; `structure/INDEX.md` routes maintainers. Update the matching user and maintainer docs when changing their contracts.

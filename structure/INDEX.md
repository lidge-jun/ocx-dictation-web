# Maintainer source map

This file routes changes to the owner of the current implementation. User instructions belong in `README.md` and `docs/`; private implementation records stay out of the public root.

| Area / contract | Source owner | Tests / documentation |
| --- | --- | --- |
| CLI, paths, migration | `bin/ocx-dictation.mjs`, `lib/paths.mjs` | path/CLI tests; `docs/configuration.md` |
| Config and browser-safe view | `lib/config.mjs` | config tests; `docs/configuration.md` |
| HTTP boundary and routes | `lib/http.mjs`, `lib/routes.mjs`, `server.mjs` | route/security tests; `SECURITY.md` |
| Sessions, SSE, notes | `lib/store.mjs`, `lib/sse.mjs`, `lib/notes.mjs` | store/notes tests; `docs/architecture.md` |
| Audio and transcription | `lib/audio.mjs`, `lib/transcribe.mjs` | audio/fake-endpoint tests; `docs/architecture.md` |
| AI, prompts, refine | `lib/ai.mjs`, `lib/prompts.mjs`, `lib/refine.mjs` | prompt/refine tests |
| Downloads and vault | `lib/export.mjs` | export containment tests; `docs/configuration.md` |
| Browser recorder and tabs | `public/js/live.js`, `recorder.js`, `store.js`, `uploader.js`, `upload-drain.js`, `recovery.js`, `tabsync.js`, `stop-ownership.js`, `local-lock-queue.js` under `public/js/`, plus `public/recorder-worklet.js` | `tests/tabsync.test.mjs`, `tests/live-recovery.test.mjs`, `tests/wp3-c-fixes.test.mjs`, browser smoke; `docs/architecture.md` |
| Browser views and drafts | `public/js/app.js`, `session.js`, `notes.js`, `note-stashes.js`, `vault.js`, `settings.js`, `ai.js`, `markdown.js`, `diff.js`, `util.js` under `public/js/` | `tests/notes-revision.test.mjs`, browser smoke; `README.md` |
| Public-tree scan and CI | `scripts/privacy-scan.mjs`, `.github/workflows/ci.yml` | `tests/privacy-scan.test.mjs`; `docs/privacy.md` |
| Brand marks and project site | `assets/logo.svg`, `assets/icon.svg`, `public/icon.svg`, `scripts/render-brand-icons.mjs` (PNG icons), `site/`, `.github/workflows/pages.yml` | `DESIGN.md`; privacy scan; Pages deploy run |

When a path or wire contract changes, update its row and linked documentation in the same change. `devlog/README.md` explains the local record boundary.

# Architecture

`bin/ocx-dictation.mjs` handles `start [--port N]`, `paths [--json]`, `doctor`, and `migrate [--from <old-app-dir>] [--dry-run]`. `server.mjs` composes dependencies and starts the loopback server. `lib/paths.mjs` and `lib/config.mjs` resolve settings; `lib/log.mjs`, `lib/time.mjs`, and `lib/util.mjs` support services. `lib/store.mjs` owns sessions and serialized writes; `lib/sse.mjs` publishes session events; `lib/audio.mjs` handles WAV and ffmpeg; `lib/transcribe.mjs` owns the endpoint queue and outage recovery; `lib/notes.mjs` owns note revisions and Markdown; `lib/ai.mjs` owns note generation; `lib/export.mjs` owns downloads and vault export; `lib/http.mjs` owns request parsing, static files, guards, and headers; `lib/routes.mjs` wires routes. `lib/prompts.mjs` and `lib/refine.mjs` hold prompt and refinement logic. These 16 modules have no import cycles; dependencies flow from config/utilities to services to routes to server, with service dependencies injected.

`public/js/app.js` boots the library and routing. `live.js` owns microphone recording and the Web Lock, `recorder.js` the audio pipeline, `store.js` browser IndexedDB, `uploader.js` upload retries, `upload-drain.js` pending-upload drainage, `recovery.js` orphaned audio recovery, `tabsync.js` BroadcastChannel messages, `stop-ownership.js` stop coordination, `session.js` the session view, `notes.js` note editing, and `note-stashes.js` per-tab drafts. Supporting UI modules own settings, AI, Markdown rendering, diffing, vault interaction, and utilities.

## Data layout

`<home>/config.json` is server-only. `<dataDir>/sessions/<id>/` holds session metadata, transcript, notes with `revision`, note Markdown, AI note Markdown, source segments, and finalized audio. `<dataDir>/prompts.json` holds prompt settings. Browser IndexedDB holds pending segments/partials until upload acknowledgement. The key and resolved filesystem paths do not appear in `/api/config`.

## Server-sent events

`GET /api/sessions/:id/events` sends JSON `data:` frames. Session stream types are `hello`, `segment`, `stats`, `meta`, `refine`, `status`, `reload`, `deleted`, and `notes`; graceful server drain sends `shutdown`. Comment heartbeat frames (`: ping`) are sent every 20 seconds. `notes` includes `revision`, `lines`, and `by` (the saving tab id). A client ignores its own note echo and reconciles another tab's newer revision. The HTTP notes PUT uses `{lines, baseRevision}`; a stale revision returns 409 with current revision and lines. Legacy PUT without `baseRevision` remains last-write-wins. AI note/chat streaming uses its own `start`/`delta`/`done`/`error` frames, not this session event list.

## Cross-tab protocol

Before microphone access, the recording tab obtains the origin-wide Web Lock `ocx-dictation:recorder` with `ifAvailable: true`; recovery uses the same lock. Other tabs mirror state over BroadcastChannel `ocx-dictation`. Every message is `{v:1,type,tabId,sessionId,epoch,seq,at,payload}`. `owner-state` is sent every second and on change with state, elapsed time, level, and device; `owner-gone` releases the mirror; `command` carries `pause`, `resume`, `stop`, or `mark` plus request/owner identifiers; `command-ack` reports the result; `notes-saved` announces a revision. Receivers reject malformed, stale-sequence, and wrong-owner messages; remote commands time out after 2 seconds and owner heartbeats expire after 3 seconds. The mic is released before the Web Lock. If Web Locks or BroadcastChannel is unavailable, recording is disabled with a user-facing explanation.

See [configuration](configuration.md) for paths and [privacy](privacy.md) for trust boundaries.

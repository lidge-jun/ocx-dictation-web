# Configuration and storage

The CLI loads defaults, then `config.json`, then supported environment variables. Unknown JSON keys produce one warning and are ignored; unknown vault keys produce a separate warning. Legacy `defaultNoteModel` is accepted as `noteModel` with a deprecation warning; obsolete unknown fields are ignored. The browser sees only version, model names, time zone, courses, and whether vault export is enabled. Use `start --port N` for a one-run port override; `paths --json` returns the resolved paths and legacy/source metadata; `doctor` reports `ffmpeg`, `ffprobe`, endpoint `/healthz`, and key presence without printing the key. `--help` and `--version` are also supported.

| JSON field | Default | Environment | Validation / meaning |
| --- | --- | --- | --- |
| `port` | `10210` | `PORT` | Integer 1–65535; `start --port N` overrides it for that run |
| `host` | `127.0.0.1` | `HOST` | Only `127.0.0.1`, `::1`, or `localhost` |
| `ocxBase` | `http://127.0.0.1:10100` | `OCX_BASE` | HTTP(S) endpoint base; credentials, query, fragment rejected |
| `ocxKey` | empty string | `OCX_KEY` | Server-side bearer key; never exposed to browser |
| `transcribeModel` | `gpt-4o-transcribe` | — | Transcription model |
| `noteModel` | `gpt-6-luna` | — | AI note model |
| `refineModel` | `gpt-6-luna--fast` | — | Transcript refinement model |
| `concurrency` | `2` | — | Integer 1–16 concurrent transcription requests |
| `timezone` | system time zone | `OCX_DICTATION_TZ` | Valid IANA time zone |
| `courses` | `[]` | — | String codes matching `[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}` |
| `ffmpegPath` | `ffmpeg` | `FFMPEG_PATH` | ffmpeg command or path |
| `ffprobePath` | `ffprobe` | `FFPROBE_PATH` | ffprobe command or path |
| `vault` | `null` | — | Optional wp4 Markdown export settings |

Example without credentials:

```json
{
  "courses": ["BIO101"],
  "timezone": "UTC",
  "vault": null
}
```

## Optional vault export

Vault export is off when `vault` is omitted or `null`. To enable it, set `vault.root` to an existing folder you own. The wp4 configuration contract is:

```json
{
  "vault": {
    "root": "~/NotesVault",
    "notePath": "{course}/{date}-{slug}.md",
    "rawPath": "_raw/{course}/{date}-transcript.txt",
    "includeRaw": false
  }
}
```

`notePath` and `rawPath` are relative templates; the defaults above are used when those fields are omitted. Set `rawPath` to `null` to disable raw-transcript export. Supported tokens are `{date}`, `{time}`, `{year}`, `{month}`, `{day}`, `{course}`, `{slug}`, and `{id}`. Values come from the session's configured-time-zone creation date, course (or `general`), sanitized title slug, and ID. The preview returns relative paths and existing-file flags, never the root. Raw export is off by default. A write can override `includeRaw` per request; `overwrite` defaults to false. Existing targets return 409 unless overwrite is confirmed. Publication writes the note first and optional raw transcript second, using temporary files and backup/rollback; the vault root must already exist, and traversal, escaping symlink ancestors, symlink destinations, and non-regular targets are refused. Symlinked ancestors that resolve inside the vault are allowed. A concurrent external process can still replace a target between the final check and the overwrite rename, so do not use this as a transactional multi-process vault writer. The browser receives only `vaultEnabled`, not the root or template paths.

## Files

`OCX_DICTATION_HOME` sets the home directory (default `~/.ocx-dictation`). `config.json` is under that home. `DATA_DIR`, if set, changes only the data directory. Otherwise data is under `<home>/data`, with `sessions/<id>/` containing `meta.json`, `transcript.json`, `notes.json`, `notes.md`, `ai-note.md`, `segments/`, and finalized audio. Prompt settings live in `data/prompts.json`; optional fake-mode audio lives in `data/debug/`. Browser upload/recovery state lives in IndexedDB for this origin. Check actual resolved paths with `node bin/ocx-dictation.mjs paths`.

## Migrating an older installation

If neither `DATA_DIR` nor `OCX_DICTATION_HOME` is set, the new home has no session directories, and the current checkout has legacy sessions, the app may use that legacy data directory in place and report it in `paths` and logs. If the home `config.json` is absent, a legacy `config.local.json` in this checkout can also be read, independently of the data choice. Neither is silently moved. Back up the source and stop the old process; from the new checkout run `node bin/ocx-dictation.mjs migrate --from <old-checkout-dir> --dry-run`, then repeat without `--dry-run` after confirming the destination home is empty. Bare `migrate` only looks in this checkout's own `data/` and `config.local.json`. Migration copies files exclusively, verifies destination and source by size and SHA-256, refuses symlinks and overlapping/nonempty destinations, and leaves the source intact. A failure may leave a partial destination that must be inspected before retrying. Do not run migration against an active recorder.

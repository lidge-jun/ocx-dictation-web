# Contributing

Thanks for improving Lecture Notes Studio. The UI language is Korean; code, tests, documentation, and commit messages use English. Keep runtime dependencies at zero unless a maintainer accepts a product-level change.

## Local setup

Use Node.js 22 or newer and install `ffmpeg`/`ffprobe`. Start the app with `npm start` against your own OpenAI-compatible endpoint. Use a temporary `OCX_DICTATION_HOME` for development and fictional sessions only. Run `node bin/ocx-dictation.mjs doctor` to inspect prerequisites; it requires a configured key even if a particular fake endpoint accepts an empty key. For recording tests use a disposable port with `start --port N`.

## Before a pull request

Run `npm run check`, `npm test`, and `npm run privacy`. Explain the user-visible change, tests, and any browser check in the pull request. Changes to recording, path resolution, migration, or privacy need a focused failure-path test. Keep all test fixtures synthetic (for example, `BIO101` and `Prof. Example`). Never commit recordings, configuration files, keys, local paths, personal names, or private planning records.

Start with [structure/INDEX.md](structure/INDEX.md) to find the owning module and documentation. Report security flaws through [SECURITY.md](SECURITY.md), not a public issue.

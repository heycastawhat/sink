# Working on Sink

Notes for coding agents (and people) picking this repo up. `README.md` is the user-facing overview and `PLAN.md`
the original design; this file is how the code fits together today and how to change it safely.

## What it is

A self-hosted notes app: a Keep-style grid of markdown notes that open fullscreen in an Obsidian-style live-preview
editor, plus todos (Obsidian Tasks syntax), Excalidraw boards, folders, backlinks, version history, share links,
templates, a Google Keep importer, email in, an MCP server for AI assistants, and plugins. One user per install. The
vault is a folder of plain `.md` files (Obsidian-compatible); SQLite only holds an index and app state, so losing the
database loses nothing a rescan can't rebuild.

## Layout

| Path | What |
|------|------|
| `server/` | Bun + Hono + `bun:sqlite`, TypeScript. Serves the API and the built web app. |
| `web/` | Vite + `@m3e/web` (Material 3 Expressive web components) + CodeMirror 6. Plain JS, no framework. |
| `android/` | Kotlin + Jetpack Compose (Material 3 Expressive). The note editor is the web editor in a WebView. |
| `docs/plugins.md`, `examples/plugins/` | Plugin API and an example plugin. |
| `.github/workflows/` | `ci.yml` (server tests + web build), `docker.yml` (GHCR image), `android.yml` (APK; releases on `v*` tags). |

### Server (`server/src/`)

- `index.ts` startup and config checks (fail closed: no sign-in allowlist, no public URL, email without
  `SINK_IMAP_AUTHSERV_ID` all refuse to start). `config.ts` env vars.
- `app.ts` wires everything: security headers (CORP same-origin except the logo files), `/api` (auth required),
  `/api/public` (share links), `/mcp`, OAuth, static web app with SPA fallback and cache headers (pages `no-cache`,
  hashed `/assets` immutable).
- `notes.ts` **the vault**: path cleaning and realpath containment (`cleanPath`, `Vault.abs`), scan/index, write with
  hash-based conflict detection (409 returns the current file), atomic writes, move (with link rewriting, case-only
  renames on case-insensitive shares), trash/restore, links index + backlinks, version history snapshots, export walk.
  Emits `VaultEvent`s.
- `db.ts` migrations (append only; `user_version`). `routes/notes.ts` notes/attachments/trash/versions/backlinks/export
  routes. `routes/share.ts` share links. `routes/events.ts` live change stream (SSE). `todos.ts` todo parsing and
  routes. `auth.ts` tokens (scopes `full`/`mcp`, optional expiry), cookie + bearer, CSRF origin check. `oidc.ts`
  sign-in. `oauth.ts` OAuth for MCP connectors (dynamic registration, PKCE, refresh rotation). `mcp.ts` MCP tools
  (all go through the REST API as the caller). `email.ts`/`html.ts` IMAP ingest. `plugins.ts` + `builtin/` plugin
  host (daily notes, webhooks). `ratelimit.ts`, `zip.ts`, `backup.ts`, `time.ts`.

### Web (`web/src/`)

- `main.js` shell: routing (hash routes `#/notes/<folder>`, `#/n/<path>`, `#/todos`, `#/trash`, `#/settings`),
  settings page, New menu, keyboard shortcuts (Cmd/Ctrl+K switcher, `n`, `/`).
- `notes.js` grid, cards (formatted excerpts), Recent row, folders/tree/tags sidebar, search (`#tag` filters
  locally), note screen (editor, autosave, conflicts, history, share, archive, backlinks), todos, trash, live changes.
- `editor.js` CodeMirror live preview (headings, tasks, callouts, tables, wikilinks, images, plugin code blocks,
  properties widget, slash commands incl. `/table`, `/template`). Must keep `root: document` (the page lives in
  `<m3e-theme>`'s shadow root; without it the caret desyncs).
- `dialogs.js` native `<dialog>` helpers (text prompt, folder picker, version history, share, list picker).
- `util.js` shared `esc`, `folderOf`, `inlineHtml`, `tableCells`. Always `esc()` before putting text in HTML.
- `board.js` Excalidraw (Obsidian plugin file format). `backlinks.js`, `templates.js`, `keep-import.js`
  (zip read in the browser with `DecompressionStream`), `plugin-api.js` + `plugins/`.
- Extra entry pages: `editor.html` + `embed-editor.js` (the Android WebView editor; talks over `window.SinkBridge`),
  `share.html` + `share.js` (read-only shared note).

### Android (`android/app/src/main/java/nz/joshp/sink/`)

- `data/` API client (`Api.kt`, `Notes.kt`), offline store and save queue (`NoteStore`, `NoteSaver`,
  `NoteSyncWorker`), live changes (`Live.kt`), settings, updates.
- `ui/` screens: `MainActivity.kt` (nav + floating tab toolbar), `NotesScreen.kt` (grid laid out bottom-up, cards),
  `NoteScreen.kt` (WebView editor host, bottom toolbar, history/share/archive), `TodosScreen.kt`, `SettingsScreen.kt`,
  `Recent.kt`, `Folders.kt`, `History.kt`, `Share.kt`, `NewMenu.kt`, `Common.kt` (`toolbarClearance()`).
- The editor page is the web `editor.html` bundled into the APK (`web/dist` is copied in at build time).
  `shouldInterceptRequest` serves `https://sink.server/` (plugin files only, with the token) and
  `https://sink.attachment/` (cached images). Don't widen that proxy; pass data in through `window.sink.*` instead.

## Commands

```bash
cd server && bun install && bun test            # 60+ tests; bunx tsc --noEmit -p . to typecheck
cd web && bun install && bun run build          # builds web/dist (the server serves it)
cd web && bun run dev                           # Vite on :5173, proxies /api to :8787
# Android: build on CI, not locally (see below). gh workflow run android.yml --ref main
```

Run a dev server against a scratch vault: set `SINK_DATA_DIR`, `SINK_NOTES_DIR`, `SINK_WEB_DIR=<repo>/web/dist`,
`SINK_PORT`, `SINK_PUBLIC_URLS=http://localhost:<port>`, `SINK_OIDC_ISSUER`/`SINK_OIDC_CLIENT_ID` (any values) and
`SINK_OIDC_ALLOW_ANY_USER=true`, then `bun src/index.ts` in `server/`. Mint a token with `Auth.issueToken` from a
small script against that data dir to call the API or set the `sink_session` cookie. Web UI checks were done with
`playwright-core` driving system Chrome (headless needs `Document.prototype.hasFocus = () => true` for CodeMirror).

## Conventions

- Match the surrounding code: comments explain *why* (often a sentence or two above a block), names are plain,
  no framework on the web side. Android mirrors web behaviour; when changing one, check the other
  (card excerpts, Recent row, `#tag` search, folder filtering, history, share).
- Every server change gets a test in `server/src/*.test.ts` (Hono `app.request` against an in-memory DB and a temp
  vault). Migrations are append-only.
- Never write to a note without its last-seen hash; a mismatch is a conflict, never an overwrite.
- Anything public (share pages, `/api/public`) exposes only that note's text (no frontmatter) and the images it
  embeds; assistants' `mcp` tokens can't manage tokens, empty the trash, share, or export.
- The repo is public: keep personal details (hosts, domains, NAS paths) out of tracked files. Deployment-specific
  config lives in the git-ignored `docker-compose.override.yml`; private notes in `HANDOFF.local.md`.
- Android: application id `nz.joshp.sink`. Release builds are signed in CI from repo secrets.
- Commits: one topic each, imperative subject, a body that says why.

## Gotchas

- Don't boot an Android emulator or run Gradle locally on the maintainer's laptop (battery); use the `android.yml`
  workflow (`workflow_dispatch` on `main` builds a test APK artifact; a `v*` tag publishes a release).
- `serveStatic({ path })` reads relative to the working directory: always pass `root` + a relative `path`.
- `secureHeaders` runs outermost and overwrites headers set later; per-path header policy has to be chosen there.
- The web page caches: pages are served `no-cache`; if a deploy looks stale, it's the browser (hard reload).
- SQLite `lower()` is ASCII only; lower-case in JS before storing anything compared case-insensitively (see links).
- CodeMirror block widgets must come from a `StateField`; clicks on replaced widgets need their own mousedown
  handling (see the table widget).

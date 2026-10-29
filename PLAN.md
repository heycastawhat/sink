# Sink — plan

Self-hosted notes app replacing Google Keep, Notion and Google Docs (personal use): a Keep-style grid of notes
that open fullscreen in an Obsidian-style markdown editor, plus todos, Excalidraw boards and email in.
Web client + Android app, both talking to one Docker container. One user per install.

History: Sink started (2026-10-22) as a Pixel Screenshots / Nothing Essential Space clone. On 2026-10-29 it became a
notes app, and the screenshot inbox (captures, AI extraction, OCR, collections, price watch, semantic search) was
removed along with its data.

## Goals

- Notes are plain markdown files on the NAS, laid out the way Obsidian expects. Losing the database loses nothing
  a rescan can't rebuild.
- Keep's feel for capture and browsing (grid, pin, colour, take-a-note), Obsidian's for writing (live preview).
- Works offline on the phone; never silently overwrites an edit made elsewhere.
- Material 3 Expressive everywhere, one shared seed colour.

## Non-goals

- Multi-user, sharing, real-time co-editing.
- Notion-style databases (relations, rollups).

## Architecture

```
Android (Kotlin/Compose + WebView editor)      Web (Vite + @m3e/web + CodeMirror)
                  \                              /
          HTTPS + bearer token / cookie (Cloudflare tunnel or LAN)
                               |
        sink container (Bun + Hono)  ── serves API + built web client
          ├─ /notes  NAS vault (markdown, attachments/, .trash/)
          ├─ /data   local disk: SQLite (index, todos, tokens, OAuth), backups
          └─ IMAP watcher (optional)
```

## Vault

Whatever folder is mounted at `/notes` (`SINK_NOTES_DIR`): `./notes`, a NAS share, an Obsidian vault.

```
notes/
  Inbox/                  emailed notes land here
  <any folders>/*.md
  Boards/*.excalidraw.md
  attachments/            images and files referenced from notes (![[name.png]])
  Todo.md                 quick todos
  .trash/                 deleted notes (same convention as Obsidian)
```

- **Index only in SQLite** (`notes` + `notes_fts`, `todos`): path, title, tags, body, hash, mtime, pinned, colour.
- **Exact text.** The server never reformats markdown. Title = first `# heading`, else frontmatter `title`, else
  file name. Tags = frontmatter `tags` + inline `#tags`. Keep's pin and colour are frontmatter `pinned:` / `color:`.
- **Saves carry the hash the client last saw**; a mismatch is a 409 with the current file, and clients keep their
  version as a "(conflict …)" sibling note. Writes are atomic (temp file + rename).
- **Paths are checked**: relative, no `..`, no hidden folders, `.md` only for notes.
- **External edits** (Obsidian via Syncthing, Finder over SMB): CIFS has no inotify, so the vault is rescanned every
  `SINK_NOTES_SCAN_SECONDS` (30) by mtime + size; opening a note re-reads it anyway.
- Network shares: a `soft` CIFS/NFS mount turns an outage into EIO, which the API returns as 503 instead of hanging.
  SQLite never goes on the share. Symlinks are followed only while they stay inside the vault.

## Todos

Checkbox lines in any note, in Obsidian Tasks syntax so both apps agree: `- [ ] Pay rates 📅 2026-11-02`,
done `- [x] … ✅ 2026-10-29`, reminder time `(@2026-10-30 18:00)` (Obsidian Reminder plugin syntax). A due date with
no time reminds at 9am. The web lists and ticks them; Android also schedules the reminder notifications.

## Boards

Excalidraw, loaded on demand on the web. Files use the Obsidian Excalidraw plugin's format (plain ```json drawing
block; compressed-json is read too). Pasted images go to `attachments/` and `## Embedded Files`. Fonts are copied
from node_modules at build, so no CDN. Android opens boards in the browser for now.

## Email in (optional)

IMAP IDLE on a dedicated mailbox. Only mail From `SINK_IMAP_ALLOWED_FROM` with an aligned DKIM/SPF pass in the
topmost `Authentication-Results` is accepted. `sink+todo@…` appends `- [ ] subject` to `Todo.md`; anything else
becomes a note in `Inbox/` with attachments embedded. Handled mail moves to `Sink/Processed` (or `Sink/Rejected`);
handled Message-IDs are remembered in SQLite.

## API (REST, JSON, bearer token or session cookie)

- `GET /api/notes` (all, with card excerpts) · `GET /api/notes?q=` (search with snippets)
- `GET/PUT/DELETE /api/notes/file?path=` · `POST /api/notes` · `PATCH /api/notes/meta?path=` · `POST /api/notes/move`
- `GET /api/notes/trash` · `POST /api/notes/trash/restore` · `DELETE /api/notes/trash?path=|all=true`: what Sink trashed is
  recorded in SQLite (`trash`) and purged after `SINK_TRASH_DAYS` (30); anything else in `.trash/` is listed but never purged
- `POST /api/notes/folders` · `POST /api/notes/scan` · `GET /api/notes/attachment?name=|path=` · `POST /api/notes/attachments`
- `GET /api/todos?view=open|done|all` · `POST /api/todos` · `POST /api/todos/toggle`
- `/mcp`: MCP for AI assistants (search, read, save, pin/colour, folders, move/rename, todos, trash and restore). Connectors sign in
  with OAuth 2.1 served by Sink (OIDC login, then consent); Claude Code can use a token from Settings. Assistant
  tokens have the `mcp` scope: notes and todos only, never `/api/auth/tokens`.
- Auth: any OIDC provider; typed allowlist (`email:`, `user:`, `sub:`); Sink refuses to start with nobody allowed.
  Cookie-authenticated writes must come from a `SINK_PUBLIC_URLS` origin. `GET /api/auth/oidc/start`, `/oidc/callback`, `POST /oidc/exchange` (Android), `/logout`,
  `/me`, `/tokens`.

## Clients

- **Web**: notes grid (pinned first, folder chips, search, take-a-note, new board), fullscreen note in the
  CodeMirror editor (`web/src/editor.js`: Obsidian-style live preview, properties, callouts, tasks, embeds,
  wikilinks), todos, settings (theme, MCP connector, devices).
- **Android**: Notes, Todos and Settings tabs; the note screen hosts the same editor (`web/editor.html`, copied into
  the APK at build, so `bun run build` in `web/` first). Offline edits queue in WorkManager. "New note" Quick Settings
  tile; text shared from other apps opens a new note.

## Plugins

`server/src/plugins.ts` (host), `server/src/builtin/` (diagrams, math, daily, webhooks), `web/src/plugin-api.js`
(client registry), `web/src/plugins/` (bundled client parts), guide in `docs/plugins.md`.

- A plugin is a folder with `plugin.json` in `SINK_PLUGINS_DIR` (`/plugins`); built-ins use the same API and can be
  turned off with `SINK_PLUGINS_DISABLED`. A plugin that fails to load is logged and skipped.
- Server: `sink.vault`, `sink.on` (vault events: note created/updated/deleted/moved, todo done/undone, from Sink or
  an external edit found by a scan), `sink.routes` (Hono at `/api/plugins/<id>/`, signed in), `sink.mcpTool`,
  `sink.every`, `sink.env` (`SINK_PLUGIN_<ID>_<KEY>`).
- Client: `codeBlock` (rendered as a block widget while the cursor is outside it), `command` (slash menu),
  `gridAction` (web grid button), `api`. Built-in client parts are bundled, so they work offline on Android; other
  plugins' files are served at `/plugins/<id>/<file>` (signed in), and the Android app proxies
  `https://sink.server/…` to them with its token (GET only).
- Plugins are trusted code the owner installs, like Obsidian's.

## Release

- Push to `main`: CI runs the tests, and `ghcr.io/heycastawhat/sink:main` / `:latest` is built for amd64 and arm64.
- Tag `v1.2.3`: also `:1.2.3` / `:1.2`, and a signed APK on the GitHub release (key from Actions secrets
  `SINK_KEYSTORE_BASE64`, `SINK_KEYSTORE_PASSWORD`, `SINK_KEY_ALIAS`, `SINK_KEY_PASSWORD`).
- The image starts as root only to chown fresh `/data` and `/notes` folders, then drops to `PUID:PGID`.

## Next

- Tables in live preview; syntax colouring in code blocks.
- Boards on Android (WebView with the board bundle).
- Version history; Keep (Takeout) and Notion import.

## Decisions

- Name: **Sink**. Seed colour **`#6750A4`**. Android package `nz.joshp.sink`.
- Auth: OIDC only (no passwords stored); any provider.
- Editor: CodeMirror 6 on raw markdown (no WYSIWYG round-tripping). It must be given `root: document`, because the web
  app sits inside `<m3e-theme>` and CodeMirror otherwise follows the slot into its shadow root and loses the caret.

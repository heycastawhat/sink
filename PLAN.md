# Sink — plan

Name: Sink. Pixel Screenshots + Nothing Essential Space, self-hosted.

Capture a screen (plus optional voice/text note saying *why*), AI reads it, pulls out
what matters, offers actions, and makes everything searchable later. Android app +
web client, both talking to one Docker container on `thonk`.

## Goals

- One-gesture capture on Android, with intent note.
- AI extraction: type, title, summary, key fields, suggested actions.
- Natural-language search across everything.
- Free or near-free to run. No paid SaaS beyond optional OpenRouter pennies.
- Material 3 Expressive everywhere, one shared seed color.
- Single container, single volume, trivial backup.

## Non-goals (v1)

- Multi-user / sharing.
- iOS, Mac capture (web client covers desktop viewing + upload).
- Audio-only "Flip to Record" captures (maybe v2).

## Architecture

```
Android (Kotlin/Compose)             Web (Vite + @m3e/web)
  capture -> upload queue               browse / search / edit / upload
          \                           /
           HTTPS + bearer token (Cloudflare tunnel or LAN)
                        |
        sink container (Bun + Hono)  ── serves API + built web client
          ├─ SQLite (WAL) + FTS5 (+ sqlite-vec, phase 3)
          ├─ /data/media  (original PNG/JPEG + thumbnails)
          └─ job worker  -> AI provider (OpenRouter | Ollama)
```

Single process: API, static web, and an in-process job queue (SQLite table polled by
the worker). No Redis, no Postgres. One volume: `/data`.

## AI: cheap or free

Provider interface, picked by env var. Two implementations:

| Provider | Use | Cost |
|---|---|---|
| `openrouter` | default. Vision model via OpenAI-compatible API. Model id from env, so swapping to whatever `:free` vision model is current is a config change | free tier (rate-limited) or cents per 1k captures |
| `ollama` | fully local. Point at an Ollama URL (thonk, or a box with a GPU). Small vision model (Qwen-VL / Gemma 3 class) | free, slower |

Keeping cost down:
- **OCR first, locally.** Android does ML Kit on-device text recognition (free, offline)
  and sends text with the image. Web uploads fall back to Tesseract in the container.
  The LLM gets OCR text + downscaled image (max 1024px) so token use stays small.
- **Voice notes transcribed on-device** with Android `SpeechRecognizer`, so only text
  goes to the server. No Whisper container needed.
- One LLM call per capture, strict JSON schema output. Retry with backoff on free-tier
  429s. Captures stay usable (OCR-searchable) even if AI is down.
- Fallback chain: primary model -> secondary model -> OCR-only.

Extraction schema (LLM output):

```json
{
  "kind": "event|receipt|product|place|code|article|message|recipe|other",
  "title": "string",
  "summary": "1-2 sentences",
  "entities": { "dates": [], "urls": [], "prices": [], "addresses": [], "people": [] },
  "tags": ["string"],
  "actions": [{ "type": "reminder|calendar|todo|open_url|copy", "label": "string", "payload": {} }]
}
```

## Data model (SQLite)

- `captures`: id, created_at, source (`share|auto|tile|web`), app_package, image_path,
  thumb_path, width, height, note_text, ocr_text, status (`pending|processing|done|failed`),
  kind, title, summary, tags (json), entities (json), pinned, archived_at, deleted_at
- `actions`: id, capture_id, type, label, payload (json), state (`suggested|accepted|done|dismissed`), due_at
- `collections` + `capture_collections`: user folders/boards.
- `jobs`: id, capture_id, kind, attempts, run_after, last_error.
- `captures_fts`: FTS5 over title, summary, note_text, ocr_text, tags.
- phase 3: `capture_vec` (sqlite-vec) for semantic search, embeddings via same provider.

## API (REST, JSON, bearer token)

- `POST /api/captures` multipart: image, note, ocr_text, source, app_package, client_id (idempotency)
- `GET /api/captures?q=&kind=&tag=&collection=&cursor=`
- `GET/PATCH/DELETE /api/captures/:id`, `POST /api/captures/:id/reprocess`
- `GET /api/media/:id/{original,thumb}`
- `PATCH /api/actions/:id`
- `GET /api/digest`: unreviewed + due items
- `GET /api/health`
- `POST /api/captures/bulk`: one change (flags, tags, collections) across many captures.
- `/api/collections` CRUD.
- `/mcp`: MCP (Streamable HTTP, stateless) for AI assistants, same bearer tokens. Tools: search_captures,
  get_capture (optionally with the image), list_collections, upcoming_reminders, update_capture, create_collection.
  Tokens minted from the web client's "Connect an AI assistant" dialog (`POST /api/auth/tokens`).
- Auth: authentik OIDC (see Decisions). `GET /api/auth/oidc/start`, `/oidc/callback`,
  `POST /oidc/exchange` (Android), `/logout`, `/me`, `/tokens`.

## Android app (Kotlin, Compose, M3 Expressive)

minSdk 30 (needed for accessibility `takeScreenshot`), target latest.

Capture modes, all landing in one bottom sheet ("add note? speak / type / skip"):
1. **Share target.** Share from the system screenshot preview or any image. Zero perms.
2. **Auto-import.** Watch `Screenshots/` via MediaStore observer + WorkManager;
   new screenshots get uploaded automatically (Pixel Screenshots behaviour). Toggle in settings.
3. **Quick Settings tile / button.** Optional AccessibilityService that calls
   `takeScreenshot()` with no MediaProjection consent prompt each time, then pops the note sheet.
   This is the Essential Key equivalent. Can be mapped to a gesture or button-mapper app.

Pipeline: capture -> on-device ML Kit OCR -> Room upload queue -> WorkManager uploads
when online (retries, idempotent `client_id`) -> polls / refreshes for AI result.

Screens: Home (grid, staggered, grouped by day), Search (M3 search bar, kind chips),
Detail (image, summary, entities, action chips -> Calendar/Reminder intents, note),
Collections, Settings (server URL, login, auto-import, provider status).
Actions open intents locally: `CalendarContract` insert, alarm/reminder, browser, clipboard.

Theme: `MaterialExpressiveTheme`, dynamic color on Android 12+ with seed fallback,
expressive motion, shape morphing on capture button, Material Symbols.

## Web client (Vite + @m3e/web)

Same stack as `~/material`. No framework unless it starts to hurt; plain modules +
`@m3e/web` components, small router. Built into the container and served by Hono.

- Masonry grid, infinite scroll, day headers.
- Search bar with live FTS results, kind/tag chips.
- Detail side sheet: zoomable image, editable title/note/tags, actions, reprocess.
- Drag-and-drop / paste upload (desktop capture path).
- Digest view: "saved this week, still care?" with keep / archive / done swipes.
- Theme: `<m3e-theme>` with the shared seed color, dark mode toggle.

## Deploy (thonk)

- `Dockerfile`: multi-stage. Build web with Bun, then runtime `oven/bun:slim` + tesseract.
- `docker-compose.yml`: one service, volume `./data:/data`, env file, port 8787.
- Deploy: rsync repo (minus `data/`, `.env`, `node_modules`, `dist`, `android`) to `josh@192.168.86.245:~/sink`, then `docker compose up -d --build` there. No git checkout on thonk.
- Add to thonk's Docker host; public access via Cloudflare tunnel (same pattern as
  `meow.110463.xyz`) or LAN-only to start.
- Ollama optional: separate container, `SINK_OLLAMA_URL=http://ollama:11434`, same network.
  Remember thonk's containers must talk by container name, not host IP.
- Backup = copy `/data`. Server writes a daily `VACUUM INTO` snapshot to `/data/backups` (keeps `SINK_BACKUP_KEEP`, default 7).

## Repo layout

```
sink/
  server/     Bun + Hono + bun:sqlite
  web/        Vite + @m3e/web
  android/    Gradle, Compose
  Dockerfile
  docker-compose.yml
  .env.example
```

## Phases

1. **Server core.** Schema, upload, media, FTS search, auth, OpenRouter provider,
   job worker, Docker image. Test with curl.
2. **Web client.** Grid, search, detail, upload, login. Deploy to thonk.
3. **Android MVP.** Login, share target, note sheet with voice, ML Kit OCR, upload queue, grid + search + detail.
4. **Android capture++.** Auto-import, accessibility tile capture, action intents.
5. **Smarts.** Ollama provider, embeddings + semantic search, digest, collections, reminders sync.

## Decisions

- Name: **Sink**.
- Seed color: **`#6750A4`** (M3 baseline purple, same as the M3 playground). Dynamic color still wins on Android 12+ if enabled in settings.
- AI: OpenRouter default. thonk has no discrete GPU (Intel UHD 620 only), so local Ollama vision is impractical there; only worth it pointed at another box with a GPU.
- Public at `sink.notahomelab.xyz` via the existing Cloudflare tunnel on thonk.
- Auth: **authentik only** (`auth.notahomelab.xyz`, provider/app slug `sink`, bound to user `josh`).
  OIDC code flow + PKCE on the server. Web gets an httpOnly cookie; Android opens a Custom Tab and
  gets a one-time code back on `nz.joshp.sink://auth`, swapped (with the app's own PKCE verifier)
  for a per-device revocable token. No password login.
- Android package: `nz.joshp.sink`.
- Auto-import screenshots: **on by default** (can be turned off in settings).

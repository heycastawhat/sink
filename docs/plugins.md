# Writing a Sink plugin

A plugin is a folder in `./plugins` (mounted at `/plugins` in the container) with a `plugin.json`. Restart Sink
to load it:

```sh
docker compose restart
docker compose logs sink | grep plugins    # "[plugins] loaded word-count"
```

A full working example lives in [`examples/plugins/word-count`](../examples/plugins/word-count): copy the folder
into `./plugins` and restart.

Plugins are code you choose to install, like Obsidian's. Server parts run inside Sink with access to all your
notes; only install plugins you trust.

## plugin.json

```json
{
  "id": "word-count",
  "name": "Word count",
  "version": "1.0.0",
  "description": "What it does, in a sentence.",
  "server": "server.ts",
  "client": "client.js",
  "styles": "styles.css"
}
```

`id` is lowercase letters, digits and dashes. `server`, `client` and `styles` are all optional; a plugin can be
just a stylesheet.

## Server part

`server.ts` (or `.js`) runs once at start. Its default export gets `sink`:

```ts
export default function setup(sink) {
  sink.routes.get("/hello", (c) => c.json({ hi: true }));   // GET /api/plugins/<id>/hello, signed in
  sink.on(async (event) => { /* react to changes */ });
  sink.mcpTool("name", { description: "…", inputSchema: {} }, async (args) => "result");
  sink.every(60 * 60 * 1000, async () => { /* hourly */ });
}
```

| | |
|---|---|
| `sink.vault` | Your notes: `list()`, `read(path)`, `write(path, content, hash)`, `create(folder, title, content)`, `move(from, to)`, `trash(path)`, `saveAttachment(name, bytes)`. `write` takes the hash from `read` (or `null` for a new note) and refuses if the note changed since, so a plugin never overwrites an edit. |
| `sink.on(fn)` | Called for every change: `note.created`, `note.updated`, `note.deleted`, `note.moved` (with `from`), `todo.done`, `todo.undone` (with `text`). `source` is `"sink"`, or `"external"` when a scan found an edit made in Obsidian or a file manager. |
| `sink.routes` | A [Hono](https://hono.dev) app mounted at `/api/plugins/<id>/`. Requests are already signed in. |
| `sink.mcpTool(name, def, handler)` | A tool AI assistants get over MCP, named `<id>_<name>`. `def.inputSchema` is a map of [zod](https://zod.dev) schemas. Return a string or an object; throw an `Error` to report a problem the assistant can read. |
| `sink.every(ms, fn)` | A scheduled job (never runs twice at once). |
| `sink.env(key, fallback)` | Settings from the environment: `sink.env("URL")` reads `SINK_PLUGIN_<ID>_URL` (id upper-cased, dashes as underscores). |
| `sink.log(...)` | Logs with the plugin's name. |
| `sink.timeZone` | The owner's time zone (`SINK_TIMEZONE`). |

The server part can only import what Bun provides; it has no `node_modules` of its own. Everything Sink offers
comes through `sink`.

## Client part

`client.js` is a plain JavaScript module (no build step) that loads in the web app and in the Android app's
editor:

```js
export default function setup(sink) {
  sink.codeBlock("chart", (source, el, { dark }) => { el.textContent = source; });
  sink.command({ id: "hello", name: "Insert a greeting", run: (ctx) => ctx.insert("Hello!") });
  sink.gridAction({ id: "random", label: "Random note", icon: "casino", run: (ctx) => ctx.openNote("Ideas.md") });
}
```

| | |
|---|---|
| `sink.codeBlock(lang, render)` | Renders ` ```lang ` blocks. `render(source, el, { dark })` fills `el` (it may be async). The block shows rendered while the cursor is elsewhere and as text while you edit it, like Obsidian. |
| `sink.command({ id, name, run })` | A slash command: type `/id` in a note. `run(ctx)` gets `ctx.insert(text)`, `ctx.text()` (the whole note) and `ctx.view` (the [CodeMirror](https://codemirror.net) view). |
| `sink.gridAction({ id, label, icon, run })` | A button next to "Take a note…" on the web. `icon` is a [Material Symbols](https://fonts.google.com/icons) name; `run(ctx)` gets `ctx.openNote(path)` and `ctx.toast(message)`. |
| `sink.api(path, init)` | `fetch` for your own server routes (`/api/plugins/<id>/<path>`), signed in. In the Android editor only `GET` works. |

`styles.css` loads with it. The page's colours are CSS variables such as `--md-sys-color-primary` and
`--md-sys-color-on-surface`, so a plugin can match light and dark themes.

## Built-in plugins

Sink's own extras use the same API, and can be turned off with `SINK_PLUGINS_DISABLED`:

| id | What it does | Settings |
|---|---|---|
| `diagrams` | ` ```mermaid ` blocks render as [Mermaid](https://mermaid.js.org) diagrams; `/mermaid` inserts one | |
| `math` | ` ```math ` blocks render with [KaTeX](https://katex.org); `/math` inserts one | |
| `daily` | "Today's note" button, `/today` `/date` `/time`, and an assistant tool that appends to today's note | `SINK_PLUGIN_DAILY_FOLDER` (`Daily`), `SINK_PLUGIN_DAILY_TEMPLATE` (`Templates/Daily.md`, with `{{date}}` `{{time}}` `{{title}}`) |
| `webhooks` | POSTs note and todo events to URLs | `SINK_PLUGIN_WEBHOOKS_URLS`, `_SECRET`, `_EVENTS`, `_QUIET_MS` |

## Webhooks

With `SINK_PLUGIN_WEBHOOKS_URLS` set, each event is POSTed as JSON:

```json
{ "event": "todo.done", "path": "Groceries.md", "text": "Oat milk", "source": "sink", "at": "2026-10-29T08:12:00.000Z" }
```

Note events carry `title` too, and `note.moved` carries `from`. While someone is typing, `note.updated` waits until
the note has been quiet for 5 seconds, so a burst of autosaves sends one event. Failed deliveries are retried three
times.

With `SINK_PLUGIN_WEBHOOKS_SECRET` set, the `X-Sink-Signature` header is `sha256=` plus the HMAC-SHA256 of the raw
body with that secret. Check it before trusting the request:

```js
const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(rawBody).digest("hex");
if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-sink-signature"] ?? ""))) reject();
```

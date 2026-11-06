# Sink

A self-hosted notes app. Your notes are plain markdown files in a folder you own, shown as a Google Keep-style
grid that opens each note fullscreen in an Obsidian-style editor. With todos, Excalidraw whiteboards, an Android
app, and an MCP server so AI assistants can read and write your notes.

- **Keep's feel:** card grid, pinned notes, colours, "Take a note…", checklists.
- **Obsidian's editor:** live preview markdown (headings, tasks, callouts, code blocks, `[[wikilinks]]` with backlinks, `#tags`,
  embedded images, properties). Files stay exactly as you wrote them.
- **Your files:** one `.md` per note in a normal folder. Point Sink at an Obsidian vault, a NAS share or a
  Syncthing folder and both apps edit the same files. Deleted notes go to `.trash/`, like Obsidian;
  Undo or the Trash page puts them back.
- **Share a note:** a link anyone can open, no account needed: read-only, or let people with the link edit after
  giving a name. Stop sharing any time.
- **Version history:** earlier versions of every note, to read or restore.
- **Leaving Keep:** import your Google Takeout zip from Settings: checklists, labels, colours, pins and images come too.
- **Leaving Notion:** import its Markdown & CSV export from Settings: the page tree, links between pages, images, and
  databases as tables with each row's properties in its page's frontmatter.
- **Web clipper:** New → Clip a web page, a bookmarklet from Settings, or Share → Sink on Android saves a page's article as a
  markdown note with its source address. Sink fetches public pages only, never anything on your own network.
- **Todos:** every `- [ ]` in every note, in one list, with due dates and reminders (Obsidian Tasks syntax).
  Recurring todos (`🔁 every week`) add their next copy when ticked; tick with Undo, tap to edit, reschedule in a tap.
  Quick add reads dates off the end ("call mum tomorrow 6pm", "bins every tuesday"); priorities sort and show,
  start dates (`🛫`) keep a todo out of the way until then, and the Todos tab counts what's overdue or due today.
- **Boards:** Excalidraw whiteboards, saved in the Obsidian Excalidraw plugin's format.
- **Android app:** the same grid and editor, works offline and syncs when you're back.
- **Obsidian plugin:** keeps a local Obsidian vault (desktop or mobile) in sync with Sink over the internet.
- **AI assistants:** connect Claude, ChatGPT or Poke as a custom connector (MCP) to search, read and write notes.
- **Email in (optional):** forward an email and it becomes a note, or `you+todo@` makes it a todo.
- **Public page:** pick a name in Settings, then Share → "Show on my public page" lists a note at
  `/public/<name>` for anyone to read (it sets `publish: true`, as Obsidian Publish does). Bare `/public` is the
  owner's page. Links between published notes work; nothing else in the vault is visible. Search engines are kept
  out unless you turn on "Let search engines find it" for a note (`searchable: true`).
- **Plugins:** diagrams (Mermaid), math (KaTeX), daily notes and webhooks built in; add your own code blocks, slash
  commands, routes, assistant tools and automations.

Accounts: everyone allowed to sign in gets their own private notes. The first account (whoever was already using
Sink, else the first to sign in) is the owner: their notes are in `SINK_NOTES_DIR`, and email in and plugins work on
them. Everyone else's notes and index are in `SINK_USERS_DIR` (default `data/users/<id>/`).

## Quick start

You need Docker, a domain or LAN address for Sink, and an OpenID Connect sign-in provider (see below).

```sh
mkdir sink && cd sink
curl -O https://raw.githubusercontent.com/heycastawhat/sink/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/heycastawhat/sink/main/.env.example
# edit .env: SINK_PUBLIC_URLS, the SINK_OIDC_* settings, SINK_OIDC_ALLOWED_USERS, SINK_TIMEZONE
docker compose up -d
```

Sink listens on port 8787. Put it behind HTTPS (Caddy, Traefik, nginx, a Cloudflare tunnel, Tailscale) before
using it from outside your network; plain http is fine on a LAN.

Your notes land in `./notes`, and the database (search index, sign-ins, backups) in `./data`. To use an existing
folder, change the `./notes:/notes` line in `docker-compose.yml`. Keep `./data` on local disk: SQLite on a network
share can corrupt. If your files belong to a user other than 1000:1000, set `PUID`/`PGID` in `.env`.

Update with `docker compose pull && docker compose up -d`.

## Sign-in

Sink doesn't store passwords; it signs you in through an OpenID Connect provider. Create a client (an "OAuth2 /
OpenID application") there with:

- **Redirect URI:** `https://<your Sink address>/api/auth/oidc/callback` (one per address in `SINK_PUBLIC_URLS`)
- **Scopes:** `openid email profile`
- **Client type:** confidential (with a secret) or public (PKCE only, leave `SINK_OIDC_CLIENT_SECRET` empty)

Then set `SINK_OIDC_ISSUER`, `SINK_OIDC_CLIENT_ID`, `SINK_OIDC_CLIENT_SECRET`, and who's allowed in with
`SINK_OIDC_ALLOWED_USERS`. Sink won't start with no one allowed. Each entry matches one thing:

- `you@example.com` (or `email:you@example.com`): your email, if the provider says it's verified
- `user:you`: your username at the provider. Only use this if people can't pick their own usernames there
- `sub:1234…` (or anything else): the provider's fixed ID for your account

Once you're in, add more people in Settings → People (the same kinds of entries); removing someone there signs them
out. For someone without an account at your provider, "Invite someone with a passkey" makes a link they open once
to create a passkey, and they sign in with that from then on (web and Android). A passkey belongs to the address it
was made on, so invite people on the address they'll use. `SINK_OIDC_ALLOWED_GROUPS` works too, for groups an admin assigns. If the provider is shared with other people,
don't use `SINK_OIDC_ALLOW_ANY_USER`.

| Provider | Issuer URL looks like |
|---|---|
| [Pocket ID](https://pocket-id.org) (simplest to self-host: passkeys only) | `https://id.example.com` |
| [authentik](https://goauthentik.io) | `https://auth.example.com/application/o/<app slug>/` |
| [Authelia](https://www.authelia.com) | `https://auth.example.com` |
| [Keycloak](https://www.keycloak.org) | `https://kc.example.com/realms/<realm>` |
| Google | `https://accounts.google.com` (allow your own address in `SINK_OIDC_ALLOWED_USERS`) |

## Android app

Download the APK from the [latest release](https://github.com/heycastawhat/sink/releases/latest), allow installs
from your browser, open it, and enter your Sink address. Newer releases install over older ones; the app checks for
one once a day (or from Settings) and offers to download it.

Or let [Obtainium](https://github.com/ImranR98/Obtainium) install and update it:
[add Sink to Obtainium](https://apps.obtainium.imranr.dev/redirect?r=obtainium://add/https://github.com/heycastawhat/sink)
(or add `https://github.com/heycastawhat/sink` as an app by hand).

- Notes and Todos tabs; notes open fullscreen in the same editor as the web (beside the list on tablets and unfolded
  phones), and boards in the same Excalidraw.
- Edits made offline are saved on the phone and sent when you're back online.
- Todo reminders arrive as notifications, with Done, 1 hour and Tomorrow buttons.
- "New note" Quick Settings tile, and "Share → Sink" from any app turns text into a note, or photos and PDFs into a
  note with them attached. A shared link on its own is clipped as a web page.

On iPhone or anywhere else, the web app works on phones too.

## Using it with Obsidian

Point Sink's `/notes` at your vault (or sync the same folder with Syncthing). Sink writes standard markdown and
understands Obsidian's conventions: frontmatter properties, `[[wikilinks]]`, `![[embeds]]`, `#tags`, callouts,
the Tasks plugin's `📅 2026-11-02` due dates, the Reminder plugin's `(@2026-11-02 09:00)` times, and Excalidraw
plugin boards. Sink adds two optional frontmatter keys of its own, `pinned: true` and `color: yellow`, which
Obsidian ignores.

If two apps edit the same note at once, Sink never overwrites: the other version is kept as a
"(conflict …)" copy next to it.

### Obsidian sync plugin

If your vault lives on a server (a NAS) and you want to use Obsidian on a laptop or phone away from home, the
plugin in [`obsidian/`](obsidian/README.md) syncs a local vault with Sink over its API: notes, images and other
files, both ways, on desktop and mobile. Install it by copying two files (see its README), then in
Settings → Sink enter your server address and press Sign in; the browser signs you in and hands back to Obsidian.

- Changes sync as you make them and as they happen on the server; edits made offline go up when you're back.
- If a note changed on both sides, you get both: the server's version keeps the name and yours is saved as
  `Note (conflict 2026-11-02).md`. Nothing is overwritten.
- Renames move the note on the server (links follow), and deletes go to Sink's trash, or your vault's trash.
- It syncs the account you sign in as, and never touches `.obsidian/`, `.trash/` or other hidden folders.

## AI assistants (MCP)

In Sink, open **Settings → AI assistants** for the connector URL (`https://<your Sink address>/mcp`). Add it as a
custom connector in Claude, ChatGPT or Poke; you sign in to Sink and approve it. For Claude Code, create a token
on the same page and run the command it shows.

Tools:

- **Notes:** `search_notes` (by words, or list a folder), `read_note`, `save_note`, `style_note` (pin, colour), `clip_url` (save a web page as a note)
- **Folders:** `create_folder`, `move_note` (move or rename a note or a whole folder)
- **Todos:** `list_todos`, `add_todo`, `complete_todo`, `update_todo`
- **Trash:** `trash_note`, `list_trash`, `restore_from_trash`. Assistants can't delete anything for good; only you can
  empty the trash.

## Plugins

Built in, on unless you turn them off with `SINK_PLUGINS_DISABLED`:

- **Diagrams:** ` ```mermaid ` code blocks render as diagrams (`/mermaid` in a note inserts one).
- **Math:** ` ```math ` blocks render with KaTeX (`/math`).
- **Daily notes:** a "Today's note" button, made from `Templates/Daily.md` if you have one; `/today`, `/date`,
  `/time`; and an assistant tool that adds to today's note.
- **Webhooks:** set `SINK_PLUGIN_WEBHOOKS_URLS` and Sink POSTs signed events (`note.created`, `todo.done`, …) to
  n8n, Home Assistant, Zapier or your own script.

Your own plugins go in `./plugins`, one folder each. A plugin can render its own code blocks, add slash commands
and buttons, add API routes and assistant tools, react to every note and todo change, and run on a schedule. See
[docs/plugins.md](docs/plugins.md) and the [word count example](examples/plugins/word-count).

## Email in (optional)

Give Sink a mailbox (a dedicated address that supports plus-addressing works best) by filling in the `SINK_IMAP_*`
settings. Forward something to it and it becomes a note in `Inbox/`, attachments included; send to `you+todo@…`
and the subject becomes a todo. Only mail from addresses in `SINK_IMAP_ALLOWED_FROM` that passes DKIM or SPF is
accepted; everything else is moved to a "Rejected" folder.

## Security notes

- Run it behind HTTPS and list every address you use in `SINK_PUBLIC_URLS`; browser requests from anywhere else
  are refused.
- Tokens for AI assistants can read and write notes and todos but can't see or create other sign-ins. Revoke them
  in Settings.
- Sink won't follow symlinks out of the notes folder, so a link synced into it can't expose the server's files.
- Email in needs `SINK_IMAP_AUTHSERV_ID` (your mail provider's name in `Authentication-Results`, e.g. `mx.google.com`), so only its verdict on a message is trusted. Sink won't start email in without it.

## Backups

Back up `./notes` (your actual notes) and `./data` (sign-ins and settings; Sink keeps daily database snapshots in
`data/backups`). The search index rebuilds itself from the notes, so the notes folder is what matters.

Notes deleted in Sink stay in `.trash/` for 30 days, then go for good (`SINK_TRASH_DAYS`, 0 keeps them). Anything
Obsidian or you put in `.trash/` shows on the Trash page but is never removed automatically.

## Development

```sh
cd server && bun install && bun test          # API (Bun + Hono + SQLite)
cd web && bun install && bun run dev           # web app (Vite), proxies /api to :8787
cd android && ./gradlew assembleDebug          # Android app; run `bun run build` in web/ first
cd obsidian && bun install && bun test && bun run build   # Obsidian plugin (tests run against ../server)
```

See [PLAN.md](PLAN.md) for how it fits together.

## License

[MIT](LICENSE)

# Sink

A self-hosted notes app. Your notes are plain markdown files in a folder you own, shown as a Google Keep-style
grid that opens each note fullscreen in an Obsidian-style editor. With todos, Excalidraw whiteboards, an Android
app, and an MCP server so AI assistants can read and write your notes.

- **Keep's feel:** card grid, pinned notes, colours, "Take a note…", checklists.
- **Obsidian's editor:** live preview markdown (headings, tasks, callouts, code blocks, `[[wikilinks]]`, `#tags`,
  embedded images, properties). Files stay exactly as you wrote them.
- **Your files:** one `.md` per note in a normal folder. Point Sink at an Obsidian vault, a NAS share or a
  Syncthing folder and both apps edit the same files. Deleted notes go to `.trash/`, like Obsidian.
- **Todos:** every `- [ ]` in every note, in one list, with due dates and reminders (Obsidian Tasks syntax).
- **Boards:** Excalidraw whiteboards, saved in the Obsidian Excalidraw plugin's format.
- **Android app:** the same grid and editor, works offline and syncs when you're back.
- **AI assistants:** connect Claude, ChatGPT or Poke as a custom connector (MCP) to search, read and write notes.
- **Email in (optional):** forward an email and it becomes a note, or `you+todo@` makes it a todo.

Single user per install: everyone runs their own.

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

`SINK_OIDC_ALLOWED_GROUPS` works too, for groups an admin assigns. If the provider is shared with other people,
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
from your browser, open it, and enter your Sink address. Newer releases install over older ones.

- Notes and Todos tabs; notes open fullscreen in the same editor as the web.
- Edits made offline are saved on the phone and sent when you're back online.
- Todo reminders arrive as notifications, with a Done button.
- "New note" Quick Settings tile, and "Share → Sink" from any app turns text into a note.

On iPhone or anywhere else, the web app works on phones too.

## Using it with Obsidian

Point Sink's `/notes` at your vault (or sync the same folder with Syncthing). Sink writes standard markdown and
understands Obsidian's conventions: frontmatter properties, `[[wikilinks]]`, `![[embeds]]`, `#tags`, callouts,
the Tasks plugin's `📅 2026-11-02` due dates, the Reminder plugin's `(@2026-11-02 09:00)` times, and Excalidraw
plugin boards. Sink adds two optional frontmatter keys of its own, `pinned: true` and `color: yellow`, which
Obsidian ignores.

If two apps edit the same note at once, Sink never overwrites: the other version is kept as a
"(conflict …)" copy next to it.

## AI assistants (MCP)

In Sink, open **Settings → AI assistants** for the connector URL (`https://<your Sink address>/mcp`). Add it as a
custom connector in Claude, ChatGPT or Poke; you sign in to Sink and approve it. For Claude Code, create a token
on the same page and run the command it shows.

Tools: `search_notes`, `read_note`, `save_note`, `list_todos`, `add_todo`.

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
- For email in, set `SINK_IMAP_AUTHSERV_ID` so only your mail provider's verdict on a message is trusted.

## Backups

Back up `./notes` (your actual notes) and `./data` (sign-ins and settings; Sink keeps daily database snapshots in
`data/backups`). The search index rebuilds itself from the notes, so the notes folder is what matters.

## Development

```sh
cd server && bun install && bun test          # API (Bun + Hono + SQLite)
cd web && bun install && bun run dev           # web app (Vite), proxies /api to :8787
cd android && ./gradlew assembleDebug          # Android app; run `bun run build` in web/ first
```

See [PLAN.md](PLAN.md) for how it fits together.

## License

[MIT](LICENSE)

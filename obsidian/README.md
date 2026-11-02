# Sink for Obsidian

Syncs an Obsidian vault with your [Sink](../README.md) server over its API, so your Sink notes are in Obsidian on
desktop and mobile, away from home too. Notes, images and other files sync both ways; Sink's vault is already plain
Obsidian-format markdown, so nothing is converted.

It syncs the account you sign in as. Sign-in is the same as the web app's, through your OpenID Connect provider.

## Install (manual)

Build it, then copy two files into the vault:

```sh
cd obsidian
bun install
bun run build          # makes main.js
mkdir -p "<your vault>/.obsidian/plugins/sink"
cp main.js manifest.json "<your vault>/.obsidian/plugins/sink/"
```

Then in Obsidian: Settings → Community plugins → turn on Sink. On mobile, copy the same two files into
`<vault>/.obsidian/plugins/sink/` on the phone (any way you move files; if you sync `.obsidian/` between devices, they
come along), then enable it there.

## Set up

Settings → Sink:

1. **Server address:** where Sink runs, e.g. `https://sink.example.com`.
2. **Sign in:** opens your browser; once you're signed in it hands back to Obsidian (`obsidian://sink-auth`) and
   syncing starts. Sign out from the same place.
3. **Folder to sync:** a folder in the vault to sync with Sink's notes (Sink's top level maps to it). Empty means
   the whole vault.

The first sync merges: files that exist only on one side go to the other, identical ones are left alone, and a note
that differs on both sides keeps both (see below). Nothing is deleted on a first sync.

## How it syncs

- On start, when something changes on the server, a few seconds after you edit, and every five minutes. The server's
  changes arrive over its event stream; where that can't be read (some networks and phones) it polls every minute.
- Every write carries the hash of what was last synced. If the other side has changed since, it isn't overwritten.
- **Both changed:** the server's version takes the file name and yours is saved as `Name (conflict 2026-11-02).md`
  (a number is added if that's taken), then uploaded as a note of its own. Merge them by hand and delete the copy.
- **Renames** move the note on the server, which rewrites links to it. **Deletes** go to Sink's trash, or your vault's
  trash (whatever Obsidian is set to do with deleted files). One side deleting a file the other edited keeps the edit.
- **Offline:** edits stay in the vault and go up when the connection is back.
- A big batch of deletions (10 or more and at least half of what's synced) is held back until you confirm it in
  "Sync now", because it usually means a side is empty by mistake, not that you deleted everything.
- Never synced: `.obsidian/`, `.trash/`, or anything starting with a dot, `node_modules`, and names Sink can't store
  (`: * ? " < > |`, or spaces at the ends). Empty folders aren't synced; a folder exists once a note is in it.
- Signing out, signing in again, or changing the folder starts the merge afresh (nothing is lost; notes that differ
  get conflict copies).

The status bar (desktop) shows `synced`, `syncing`, `offline`, `N conflicts` or `N problems`; click it to sync and
see problems.

## Commands

- **Sync now**
- **Open in Sink:** the open note in the web app.
- **Copy share link:** makes (or reuses) the note's read-only share link. Boards can't be shared yet.
- **Version history:** Sink's versions of the open note. Restoring saves that text as the note (the current text
  stays in the history) and brings it here.

## Notes

- The token is stored in the plugin's `data.json` inside the vault's `.obsidian/`. If you sync `.obsidian/` somewhere
  shared, exclude `plugins/sink/data.json`. You can revoke it in Sink's Settings (it is listed there as "Obsidian").
- Files in Sink's trash can be restored from Sink's Trash page (notes) or found in `.trash/` on the server (other files).

## Development

```sh
bun install && (cd ../server && bun install)   # the tests run against the server's code
bun test                                        # plan rules, and the sync engine against a real in-process server
bun run typecheck
bun run build                                   # or `bun run dev` to rebuild on change
```

The decisions about what to pull, push or keep both of live in `src/plan.ts` and only see hashes. `src/engine.ts`
carries them out against two small interfaces (`Local`, and `SinkApi`), so the tests use a folder on disk and the
real server app. `main.ts`, `src/vault.ts`, `src/settings.ts` and `src/ui.ts` are the only files that touch Obsidian.

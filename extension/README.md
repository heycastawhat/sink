# Sink for Chrome

A side panel for your Sink server: write a quick note in the same live-preview editor as the web app, add a todo in
plain words ("call mum tomorrow 6pm"), and clip web pages.

- **Clip page** saves the page's article as a new note in your inbox folder (Settings, ⋮; `Inbox` by default) and
  opens it. The extension sends the page as your browser shows it, so pages behind a login or built by scripts clip
  too; the server turns it into markdown and fetches nothing itself.
- **Add selection** puts the text selected on the page into the open note, with a link back.
- **Add link** puts a `[title](url)` link to the page into the open note.
- Right-click a page for the same three, or press Alt+Shift+S to clip. Alt+S opens the panel.
- Find a note at the top to open it; `[[wikilinks]]` complete and open as in the web app. Notes save as you type, with
  the usual conflict check: if a note changed elsewhere, your version is kept as its own note.

## Install

```bash
cd web && bun install        # the panel bundles the web app's editor
cd ../extension && bun run build
```

Open `chrome://extensions`, turn on Developer mode, and **Load unpacked** the `extension/dist` folder. `bun run zip`
makes `sink-extension.zip` for the Chrome Web Store.

## Signing in

Enter your server's address; Chrome asks to let the extension reach it (the only site it can reach until you allow
more). Sign-in opens in a tab with your usual provider; the server hands a one-time code back to its own
`/api/auth/extension` page, which the extension reads, closes, and swaps (with a PKCE verifier only it holds) for a
token. The token is listed under Settings → Devices as "Browser extension" and can only read and write notes and
todos, as an assistant's can: it can't share, publish, export, empty the trash or manage sign-ins. Passkey-only
accounts can't sign in here yet.

## Reading pages

Clipping reads the page through `activeTab`, which Chrome grants when you use the right-click menu or the shortcut. The
panel's buttons need more: on the first one that can't read the page, allow "Clip from the panel on any site" in
Settings (⋮), or keep using the menu. Browser pages (`chrome://`) and the Web Store can't be read by any extension.

## Privacy

See [PRIVACY.md](PRIVACY.md).

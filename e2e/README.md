# Browser tests

Playwright (`playwright-core`) drives Chromium against a real Sink server (`bun src/index.ts`) on a free port, with an
empty vault and database in a temp folder, signed in with a token cookie. No sign-in provider is contacted.

```bash
cd web && bun install && bun run build          # the server serves web/dist
cd ../server && bun install                     # the harness imports its auth code
cd ../e2e && bun install
bunx playwright-core install --with-deps chromium   # once (SINK_E2E_CHROME=/path/to/chrome uses a browser you already have)
bun run test                                    # every spec; one spec: bun test todos.test.ts
```

- Use `bun run test`, not `bun test`: it runs each spec file in its own process. Bun 1.3.14 (CI's version) hangs
  Playwright's clicks when several of these files share one `bun test` process (each file alone passes), so the script
  keeps them apart. Newer Bun doesn't need it.
- `harness.ts`: `suite()` gives a spec file one server and browser, and `it` (like `test`, but it saves screenshots to
  `test-results/` on failure). `eventually()` retries assertions while autosave or live sync settles. `s.sink.note()`
  seeds a note through the API; `s.sink.read()` reads what's on disk.
- Tests in a file share a vault, so each uses notes of its own.
- `it.failing` marks a known, unfixed bug (see the table toolbar in `tables.test.ts`): it passes while the bug exists
  and fails once it's fixed, which is the cue to make it a plain `it`.
- `.github/workflows/e2e.yml` runs this on pull requests and pushes to main. It needs nothing but read access, and
  doesn't touch `android.yml`'s release triggers.

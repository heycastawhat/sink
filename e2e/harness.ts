import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, test } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { Auth } from "../server/src/auth";
import { openDb } from "../server/src/db";

const root = resolve(import.meta.dirname, "..");
const webDir = join(root, "web", "dist");

/** A throwaway Sink: the real server process on a free port, with an empty vault and database in a temp folder. */
export type Sink = Awaited<ReturnType<typeof startSink>>;

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

export async function startSink() {
  if (!existsSync(join(webDir, "index.html"))) throw new Error("web/dist is missing: run `bun run build` in web/ first");
  const dir = mkdtempSync(join(tmpdir(), "sink-e2e-"));
  const dataDir = join(dir, "data");
  const notesDir = join(dir, "notes");
  mkdirSync(notesDir, { recursive: true });

  // Sign in the way a person would end up signed in, without a provider: a token in the database, sent as the cookie.
  const db = openDb(join(dataDir, "sink.db"));
  const token = new Auth(db).issueToken("e2e", "e2e-user");
  db.close();

  const port = await freePort();
  const url = `http://localhost:${port}`;
  const server = Bun.spawn(["bun", "src/index.ts"], {
    cwd: join(root, "server"),
    env: {
      ...process.env,
      SINK_PORT: String(port),
      SINK_DATA_DIR: dataDir,
      SINK_NOTES_DIR: notesDir,
      SINK_USERS_DIR: join(dir, "users"),
      SINK_PLUGINS_DIR: join(dir, "plugins"),
      SINK_WEB_DIR: webDir,
      SINK_PUBLIC_URLS: url,
      // Never contacted: sign-in isn't used, but the server refuses to start without a provider and an allowlist.
      SINK_OIDC_ISSUER: "https://idp.invalid",
      SINK_OIDC_CLIENT_ID: "sink-e2e",
      SINK_OIDC_ALLOW_ANY_USER: "true",
      SINK_BACKUP_KEEP: "0",
      SINK_TIMEZONE: "UTC",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let log = "";
  for (const stream of [server.stdout, server.stderr]) {
    void (async () => {
      for await (const chunk of stream) log += new TextDecoder().decode(chunk);
    })();
  }

  const started = Date.now();
  for (;;) {
    if (server.exitCode !== null) throw new Error(`Sink exited with ${server.exitCode}:\n${log}`);
    if (await fetch(`${url}/api/health`).then((r) => r.ok, () => false)) break;
    if (Date.now() - started > 20_000) throw new Error(`Sink did not start:\n${log}`);
    await Bun.sleep(100);
  }

  /** The REST API as the signed-in account, to set a test up faster than clicking through it. */
  const api = async (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const { json, ...rest } = init;
    const res = await fetch(`${url}/api${path}`, {
      ...rest,
      headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}), ...rest.headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
    if (!res.ok) throw new Error(`${rest.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
    return res.headers.get("content-type")?.includes("json") ? res.json() : res.text();
  };

  // The wide-screen layout is a per-account choice asked on first sign-in; settle it so no picker gets in the way.
  await api("/prefs", { method: "PATCH", json: { layout: "classic", layoutChosen: true } });

  return {
    url,
    token,
    notesDir,
    api,
    /** Creates a note through the API; returns its path. */
    async note(path: string, content: string) {
      await api(`/notes/file?path=${encodeURIComponent(path)}`, { method: "PUT", json: { content, base_hash: null } });
      return path;
    },
    /** What is on disk in the vault right now (null if there's no such file). */
    read(path: string): string | null {
      const abs = join(notesDir, path);
      return existsSync(abs) ? readFileSync(abs, "utf8") : null;
    },
    files(): string[] {
      return readdirSync(notesDir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name).slice(notesDir.length + 1))
        .filter((p) => !p.startsWith("."))
        .sort();
    },
    async stop() {
      server.kill("SIGTERM");
      await server.exited;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** One shared browser per test file: a signed-in page per test (`open`), thrown away afterwards. */
export async function startBrowser(sink: Sink) {
  const browser: Browser = await chromium.launch({
    // CI installs Playwright's own Chromium; elsewhere SINK_E2E_CHROME can point at a system browser.
    executablePath: process.env.SINK_E2E_CHROME || undefined,
    args: ["--no-sandbox"],
  });
  const contexts: BrowserContext[] = [];

  /** A new browser profile (cookies and storage of its own), signed in unless `signedIn` is false. */
  async function profile(signedIn = true): Promise<BrowserContext> {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    contexts.push(context);
    if (signedIn) await context.addCookies([{ name: "sink_session", value: sink.token, url: sink.url }]);
    return context;
  }

  /** A page in `context` that CodeMirror treats as focused (headless Chrome says it isn't, which stops it tracking the caret). */
  async function page(context: BrowserContext): Promise<Page> {
    const p = await context.newPage();
    // A selector that never matches should fail the test well before the test's own timeout.
    p.setDefaultTimeout(8_000);
    await p.addInitScript(() => {
      Document.prototype.hasFocus = () => true;
    });
    return p;
  }

  /** A signed-in page on the wide-screen layout, at `hash` (the home screen by default). */
  async function open(hash = "#/notes"): Promise<Page> {
    const p = await page(await profile());
    await p.goto(`${sink.url}/${hash}`);
    return p;
  }

  return {
    open,
    profile,
    page,
    /** Screenshots of every open page, for working out why a test failed. */
    async snapshot(name: string) {
      const dir = join(import.meta.dirname, "test-results");
      mkdirSync(dir, { recursive: true });
      let n = 0;
      for (const context of contexts) {
        for (const p of context.pages()) {
          await p.screenshot({ path: join(dir, `${name.replace(/[^\w-]+/g, "_")}-${n++}.png`) }).catch(() => {});
        }
      }
    },
    async close() {
      await Promise.all(contexts.map((c) => c.close().catch(() => {})));
      await browser.close();
    },
  };
}

/**
 * One server and browser for a file's tests. `it` is `test` that leaves screenshots in e2e/test-results when it fails,
 * and closes the pages the test opened. Every test in a file shares the vault, so each uses notes of its own.
 */
export function suite() {
  let sink!: Sink;
  let browser!: Awaited<ReturnType<typeof startBrowser>>;
  beforeAll(async () => {
    sink = await startSink();
    browser = await startBrowser(sink);
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await sink?.stop();
  });
  const it = Object.assign((name: string, fn: () => Promise<void>, timeout = 30_000) =>
    test(
      name,
      async () => {
        try {
          await fn();
        } catch (err) {
          await browser.snapshot(name);
          throw err;
        }
      },
      timeout,
    ), {
    /** A test for a bug that's known and not fixed yet: it passes while the bug is there, and fails once it's fixed (so it gets turned into a plain `it`). */
    failing: (name: string, fn: () => Promise<void>, timeout = 30_000) => test.failing(name, fn, timeout),
  });
  return {
    it,
    get sink() {
      return sink;
    },
    get browser() {
      return browser;
    },
  };
}

/**
 * Runs `check` (assertions, usually about the page or the vault on disk) until it stops throwing, for up to `ms`.
 * Autosave, live sync and the server's index all settle a moment after the click or keystroke that caused them.
 */
export async function eventually<T>(check: () => T | Promise<T>, ms = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    try {
      return await check();
    } catch (err) {
      if (Date.now() - started > ms) throw err;
      await Bun.sleep(100);
    }
  }
}

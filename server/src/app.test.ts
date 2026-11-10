import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations, openDb } from "./db";
import { Auth, s256 } from "./auth";
import { Oidc } from "./oidc";
import { createApp } from "./app";
import { Backups } from "./backup";
import { Users } from "./users";
import { robotsFor } from "./routes/publish";
import { icsFeed } from "./routes/calendar";
import { pageText } from "./html";
import { readdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync, symlinkSync } from "node:fs";
import { Vault, cardText, sha256, parseNote, readFrontmatter, inlineTags, cleanPath, fileNameFor, toFtsQuery, firstImage } from "./notes";
import { localIso, localTime, utcOffset } from "./time";
import { editTodo, nextDate, nextOccurrence, parseQuick, parseTodos, setDone, setStatus, todoLine } from "./todos";

// A 1x1 PNG, for attachment uploads.
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

let setup: ReturnType<typeof makeSetup>;

const ISSUER = "https://auth.test/application/o/sink/";
const PUBLIC = "https://sink.test";

/** Stand-in for an OIDC provider: discovery + token endpoint, minting an id_token for `user`. */
function fakeAuthentik() {
  const state = {
    nonce: "",
    user: { sub: "abc123", preferred_username: "sam", email: "sam@example.com", email_verified: true } as Record<string, unknown>,
    tokenCalls: 0,
    authMethods: undefined as string[] | undefined,
    lastToken: null as { headers: Headers; body: URLSearchParams } | null,
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: "https://auth.test/application/o/authorize/",
        token_endpoint: "https://auth.test/application/o/token/",
        ...(state.authMethods && { token_endpoint_auth_methods_supported: state.authMethods }),
      });
    }
    if (url === "https://auth.test/application/o/token/") {
      state.tokenCalls++;
      const body = new URLSearchParams(String(init?.body));
      state.lastToken = { headers: new Headers(init?.headers), body };
      if (body.get("code") !== "good-code" || !body.get("code_verifier")) return new Response("bad", { status: 400 });
      const claims = { iss: ISSUER, aud: "sink-client", exp: Date.now() / 1000 + 300, nonce: state.nonce, ...state.user };
      const id_token = `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
      return Response.json({ id_token, access_token: "a" });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { state, fetchImpl };
}

function makeSetup(allowedUsers: string[] = [], oidcExtra: { clientSecret?: string; allowAnyone?: boolean } = {}) {
  const db = openDb(":memory:");
  const vaultDir = mkdtempSync(join(tmpdir(), "sink-vault-"));
  const vault = new Vault(db, vaultDir);
  const auth = new Auth(db);
  const authentik = fakeAuthentik();
  const oidc = new Oidc(
    {
      issuer: ISSUER,
      clientId: "sink-client",
      clientSecret: oidcExtra.clientSecret ?? "secret",
      allowedUsers,
      allowedGroups: [],
      // Most tests don't care who signs in.
      allowAnyone: oidcExtra.allowAnyone ?? allowedUsers.length === 0,
      name: "Pocket ID",
    },
    authentik.fetchImpl,
  );
  const usersDir = mkdtempSync(join(tmpdir(), "sink-users-"));
  const users = new Users(db, { db, vault }, { dir: usersDir });
  const app = createApp({
    db,
    vault,
    users,
    auth,
    oidc,
    config: { secureCookies: false, maxUploadBytes: 5 * 1024 * 1024, webDir: undefined, publicUrls: [PUBLIC] },
  });
  return { db, app, authentik, auth, vault, vaultDir, users, usersDir };
}

/** Runs /oidc/start, plays authentik, returns the callback response. */
async function signIn(query = "client=web", code = "good-code") {
  const start = await setup.app.request(`/api/auth/oidc/start?${query}`, { headers: { host: "sink.test", "x-forwarded-proto": "https" } });
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get("location")!);
  setup.authentik.state.nonce = authorize.searchParams.get("nonce")!;
  return { authorize, callback: await setup.app.request(`/api/auth/oidc/callback?code=${code}&state=${authorize.searchParams.get("state")}`) };
}

async function login(): Promise<string> {
  return setup.auth.issueToken("test", "abc123");
}

const get = (token: string, path: string) =>
  setup.app.request(path, { headers: { authorization: `Bearer ${token}` } });

beforeEach(() => {
  setup = makeSetup();
});

describe("auth", () => {
  test("rejects unauthenticated api calls", async () => {
    expect((await setup.app.request("/api/notes")).status).toBe(401);
    expect((await setup.app.request("/api/todos")).status).toBe(401);
    expect((await setup.app.request("/api/notes/attachment?name=x.png")).status).toBe(401);
  });

  test("web sign-in through authentik sets a session cookie", async () => {
    const { authorize, callback } = await signIn();
    expect(authorize.origin + authorize.pathname).toBe("https://auth.test/application/o/authorize/");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${PUBLIC}/api/auth/oidc/callback`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(`${PUBLIC}/`);
    const cookie = callback.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    const session = cookie.split(";")[0]!;
    expect((await setup.app.request("/api/notes", { headers: { cookie: session } })).status).toBe(200);
  });

  test("state is single use and unknown origins fall back to the configured one", async () => {
    const start = await setup.app.request("/api/auth/oidc/start", { headers: { host: "evil.example" } });
    const authorize = new URL(start.headers.get("location")!);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${PUBLIC}/api/auth/oidc/callback`);
    setup.authentik.state.nonce = authorize.searchParams.get("nonce")!;
    const state = authorize.searchParams.get("state");
    expect((await setup.app.request(`/api/auth/oidc/callback?code=good-code&state=${state}`)).status).toBe(302);
    expect((await setup.app.request(`/api/auth/oidc/callback?code=good-code&state=${state}`)).status).toBe(400);
  });

  test("bad code and wrong user are refused", async () => {
    expect((await signIn("client=web", "bad-code")).callback.status).toBe(502);
    setup = makeSetup(["someone-else"]);
    expect((await signIn()).callback.status).toBe(403);
    setup = makeSetup(["user:SAM"]);
    expect((await signIn()).callback.status).toBe(302);
    setup = makeSetup(["sub:abc123"]);
    expect((await signIn()).callback.status).toBe(302);
  });

  test("allowlist entries only match their own kind of claim", async () => {
    // A bare name is a subject ID, not a username someone could pick.
    setup = makeSetup(["sam"]);
    expect((await signIn()).callback.status).toBe(403);
    // A username that looks like the owner's email doesn't pass as the email.
    setup = makeSetup(["owner@example.com"]);
    setup.authentik.state.user = { sub: "evil", preferred_username: "owner@example.com", email: "evil@example.com", email_verified: true };
    expect((await signIn()).callback.status).toBe(403);
    setup.authentik.state.user = { sub: "owner", preferred_username: "o", email: "Owner@Example.com", email_verified: true };
    expect((await signIn()).callback.status).toBe(302);
  });

  test("nobody gets in without an allowlist; unverified email doesn't count", async () => {
    setup = makeSetup([], { allowAnyone: false });
    expect((await signIn()).callback.status).toBe(403);

    setup = makeSetup(["sam@example.com"]);
    setup.authentik.state.user = { sub: "zzz", preferred_username: "mallory", email: "sam@example.com", email_verified: false };
    expect((await signIn()).callback.status).toBe(403);
    setup.authentik.state.user.email_verified = "true";
    expect((await signIn()).callback.status).toBe(302);
  });

  test("client secret goes where the provider wants it, or nowhere for a public client", async () => {
    await signIn();
    expect(setup.authentik.state.lastToken!.headers.get("authorization")).toStartWith("Basic ");

    setup = makeSetup();
    setup.authentik.state.authMethods = ["client_secret_post"];
    await signIn();
    expect(setup.authentik.state.lastToken!.headers.get("authorization")).toBeNull();
    expect(setup.authentik.state.lastToken!.body.get("client_secret")).toBe("secret");

    setup = makeSetup([], { clientSecret: "" });
    expect((await signIn()).callback.status).toBe(302);
    expect(setup.authentik.state.lastToken!.headers.get("authorization")).toBeNull();
    expect(setup.authentik.state.lastToken!.body.get("client_id")).toBe("sink-client");
    expect(setup.authentik.state.lastToken!.body.get("client_secret")).toBeNull();
  });

  test("cookie sessions only change things from Sink's own pages", async () => {
    const { callback } = await signIn();
    const session = callback.headers.get("set-cookie")!.split(";")[0]!;
    const post = (headers: Record<string, string>) =>
      setup.app.request("/api/notes", {
        method: "POST",
        headers: { cookie: session, "content-type": "application/json", ...headers },
        body: JSON.stringify({ title: "x" }),
      });
    expect((await post({})).status).toBe(403);
    expect((await post({ origin: "https://wiki.sink.test", "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await post({ origin: PUBLIC })).status).toBe(201);
    expect((await post({ "sec-fetch-site": "same-origin" })).status).toBe(201);
    // Reading is fine, and bearer tokens aren't sent by browsers on their own.
    expect((await setup.app.request("/api/notes", { headers: { cookie: session } })).status).toBe(200);
    expect((await setup.app.request("/api/notes", { method: "POST", headers: { authorization: `Bearer ${await login()}` }, body: "{}" })).status).toBe(201);
  });

  test("assistant tokens reach notes and todos, never other tokens", async () => {
    const owner = await login();
    const res = await setup.app.request("/api/auth/tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Claude Code" }),
    });
    const mcp = ((await res.json()) as any).token;
    const as = (method: string, path: string, body?: unknown) =>
      setup.app.request(path, { method, headers: { authorization: `Bearer ${mcp}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect((await as("GET", "/api/notes")).status).toBe(200);
    expect((await as("GET", "/api/todos")).status).toBe(200);
    expect((await as("GET", "/api/auth/tokens")).status).toBe(403);
    expect((await as("POST", "/api/auth/tokens", { name: "backdoor" })).status).toBe(403);
    const ownerId = ((await (await get(owner, "/api/auth/me")).json()) as any).tokenId;
    expect((await as("DELETE", `/api/auth/tokens/${ownerId}`)).status).toBe(403);
  });

  test("assistant tokens can't delete anything for good", async () => {
    const owner = await login();
    const res = await setup.app.request("/api/auth/tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Claude Code" }),
    });
    const mcp = ((await res.json()) as any).token;
    const as = (method: string, path: string, body?: unknown) =>
      setup.app.request(path, { method, headers: { authorization: `Bearer ${mcp}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    await as("POST", "/api/notes", { title: "Keep", content: "# Keep" });
    expect((await as("DELETE", "/api/notes/file?path=Keep.md")).status).toBe(200);
    expect((await as("DELETE", "/api/notes/trash?path=Keep.md")).status).toBe(403);
    expect((await as("DELETE", "/api/notes/trash?all=true")).status).toBe(403);
    expect((await as("POST", "/api/notes/trash/restore", { path: "Keep.md" })).status).toBe(200);
  });

  test("the public health check says nothing about the notes", async () => {
    expect(await (await setup.app.request("/api/health")).json()).toEqual({ ok: true });
  });

  test("the login screen can name the provider", async () => {
    expect(await (await setup.app.request("/api/auth/info")).json()).toEqual({ provider: "Pocket ID", passkeys: false });
  });

  test("nonce mismatch is refused", async () => {
    const start = await setup.app.request("/api/auth/oidc/start");
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    setup.authentik.state.nonce = "not-the-nonce";
    expect((await setup.app.request(`/api/auth/oidc/callback?code=good-code&state=${state}`)).status).toBe(502);
  });

  test("android hand-back needs the app's PKCE verifier", async () => {
    const verifier = "v".repeat(64);
    const { callback } = await signIn(`client=android&device=Pixel&challenge=${s256(verifier)}`);
    const location = new URL(callback.headers.get("location")!);
    expect(location.protocol).toBe("nz.joshp.sink:");
    const code = location.searchParams.get("code")!;

    const exchange = (v: string) =>
      setup.app.request("/api/auth/oidc/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, verifier: v }),
      });
    expect((await exchange("w".repeat(64))).status).toBe(400);
    // A failed attempt burns the code.
    expect((await exchange(verifier)).status).toBe(400);

    const again = await signIn(`client=android&challenge=${s256(verifier)}`);
    const code2 = new URL(again.callback.headers.get("location")!).searchParams.get("code")!;
    const res = await setup.app.request("/api/auth/oidc/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code2, verifier }),
    });
    const { token } = (await res.json()) as { token: string };
    expect((await get(token, "/api/notes")).status).toBe(200);
  });

  test("a QR code signs a phone in once, as the same account", async () => {
    const token = await login();
    const make = async (t: string) => {
      const res = await setup.app.request("/api/auth/qr", { method: "POST", headers: { authorization: `Bearer ${t}` } });
      return { status: res.status, url: res.ok ? new URL(((await res.json()) as { url: string }).url) : null };
    };
    expect((await make(setup.auth.issueToken("assistant", "abc123", "mcp"))).status).toBe(403);
    const { url } = await make(token);
    expect(url!.origin).toBe(PUBLIC);
    const redeem = (code: string, cookie = false) =>
      setup.app.request("/api/auth/qr/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, device: "Pixel", cookie }),
      });
    const code = url!.searchParams.get("login")!;
    const res = await redeem(code);
    const phone = ((await res.json()) as { token: string }).token;
    expect(((await (await get(phone, "/api/auth/me")).json()) as { subject: string }).subject).toBe("abc123");
    expect((await redeem(code)).status).toBe(400);

    const web = await redeem((await make(token)).url!.searchParams.get("login")!, true);
    const session = web.headers.get("set-cookie")!.split(";")[0]!;
    expect((await setup.app.request("/api/notes", { headers: { cookie: session } })).status).toBe(200);
  });

  test("revoked token stops working", async () => {
    const token = await login();
    await setup.app.request("/api/auth/logout", { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect((await get(token, "/api/notes")).status).toBe(401);
  });
});

describe("web app", () => {
  test("the service worker is always rechecked, hashed assets kept for good", async () => {
    const webDir = mkdtempSync(join(tmpdir(), "sink-web-"));
    mkdirSync(join(webDir, "assets"));
    writeFileSync(join(webDir, "index.html"), "<!doctype html>");
    writeFileSync(join(webDir, "sw.js"), "");
    writeFileSync(join(webDir, "assets/main-abc.js"), "");
    const app = createApp({
      db: setup.db,
      vault: setup.vault,
      auth: setup.auth,
      oidc: new Oidc({ issuer: ISSUER, clientId: "c", clientSecret: "", allowedUsers: [], allowedGroups: [], allowAnyone: true }),
      config: { secureCookies: false, maxUploadBytes: 1024, webDir, publicUrls: [PUBLIC] },
    });
    expect((await app.request("/sw.js")).headers.get("cache-control")).toBe("no-cache");
    expect((await app.request("/assets/main-abc.js")).headers.get("cache-control")).toContain("immutable");
    expect((await app.request("/assets/main-old.js")).status).toBe(404);
    const page = await app.request("/");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    // Fonts are bundled, so pages never load anything from Google.
    expect(page.headers.get("content-security-policy")).toContain("font-src 'self' data:;");
    expect(page.headers.get("content-security-policy")).not.toContain("google");
  });
});

describe("mcp", () => {
  let rpcId = 0;
  const rpc = async (token: string | null, method: string, params: unknown = {}) => {
    const res = await setup.app.request("/mcp", {
      method: "POST",
      headers: {
        ...(token && { authorization: `Bearer ${token}` }),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const call = async (token: string, name: string, args: unknown = {}) => {
    const { body } = await rpc(token, "tools/call", { name, arguments: args });
    const result = body.result;
    return { result, data: result.isError ? null : JSON.parse(result.content[0].text) };
  };

  test("needs a token", async () => {
    expect((await rpc(null, "tools/list")).status).toBe(401);
  });

  test("tokens can be minted for other clients", async () => {
    const token = await login();
    const res = await setup.app.request("/api/auth/tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Claude Code" }),
    });
    expect(res.status).toBe(201);
    const minted = ((await res.json()) as any).token;
    expect((await rpc(minted, "tools/list")).status).toBe(200);
  });

  test("notes and todos: save, search, read, edit with hash, add and list todos", async () => {
    const token = await login();
    const tools = (await rpc(token, "tools/list")).body.result.tools.map((t: any) => t.name);
    expect(tools.sort()).toEqual([
      "add_todo",
      "clip_url",
      "complete_todo",
      "create_folder",
      "list_todos",
      "list_trash",
      "move_note",
      "read_note",
      "restore_from_trash",
      "save_note",
      "search_notes",
      "style_note",
      "trash_note",
      "update_todo",
    ]);

    const created = await call(token, "save_note", { title: "Packing list", folder: "Trips", content: "# Packing list\n\n- [ ] passport\n" });
    expect(created.data.created.path).toBe("Trips/Packing list.md");
    const found = await call(token, "search_notes", { query: "passport" });
    expect(found.data.results.map((r: any) => r.path)).toEqual(["Trips/Packing list.md"]);

    const read = await call(token, "read_note", { path: "Trips/Packing list.md" });
    expect(read.result.content[1].text).toContain("- [ ] passport");
    // Assistants often pass the title or drop ".md".
    for (const ref of ["Packing list", "packing list.md", "Trips/Packing list"]) {
      expect((await call(token, "read_note", { path: ref })).data.path).toBe("Trips/Packing list.md");
    }
    expect((await call(token, "read_note", { path: "Nope" })).result.isError).toBe(true);
    const noHash = await call(token, "save_note", { path: "Trips/Packing list.md", content: "x" });
    expect(noHash.result.isError).toBe(true);
    const stale = await call(token, "save_note", { path: "Trips/Packing list.md", hash: "0".repeat(64), content: "x" });
    expect(stale.result.isError).toBe(true);
    const edited = await call(token, "save_note", { path: "Trips/Packing list.md", hash: read.data.hash, content: read.result.content[1].text + "- [ ] charger\n" });
    expect(edited.data.saved.title).toBe("Packing list");

    const added = await call(token, "add_todo", { text: "call the bank", due: "2026-11-02", time: "09:30" });
    expect(added.data).toEqual({ added: "- [ ] call the bank 📅 2026-11-02 (@2026-11-02 09:30)", path: "Todo.md" });
    const todos = await call(token, "list_todos");
    expect(todos.data.todos.map((t: any) => t.text)).toEqual(["call the bank", "passport", "charger"]);

    const bank = todos.data.todos[0];
    const ticked = await call(token, "complete_todo", { path: bank.path, line: bank.line, raw: bank.raw });
    expect(ticked.data.done).toMatch(/^- \[x\] call the bank/);
    expect((await call(token, "list_todos")).data.todos.map((t: any) => t.text)).toEqual(["passport", "charger"]);
    const passport = (await call(token, "list_todos")).data.todos[0];
    const moved = await call(token, "update_todo", { path: passport.path, line: passport.line, raw: passport.raw, due: "2026-12-01" });
    expect(moved.data.updated).toBe("- [ ] passport 📅 2026-12-01");
  });

  test("clip_url goes through the clip API and refuses private addresses", async () => {
    const token = await login();
    const clipped = await call(token, "clip_url", { url: "http://169.254.169.254/latest/meta-data/" });
    expect(clipped.result.isError).toBe(true);
    expect(clipped.result.content[0].text).toBe("that address isn't allowed");
    expect((await setup.app.request("/api/clip", { method: "POST", body: "{}" })).status).toBe(401);
  });

  test("folders, moving, trash and pin/colour", async () => {
    const token = await login();
    await call(token, "save_note", { title: "Idea", content: "# Idea\n\nmake soup\n" });
    expect((await call(token, "create_folder", { path: "Projects/Soup" })).data.folder).toBe("Projects/Soup");

    // Into a folder, keeping the name; then a rename by full path, without .md.
    expect((await call(token, "move_note", { from: "Idea", folder: "Projects/Soup" })).data.to).toBe("Projects/Soup/Idea.md");
    expect((await call(token, "move_note", { from: "Projects/Soup/Idea.md", to: "Projects/Soup/Plan" })).data.to).toBe("Projects/Soup/Plan.md");
    expect((await call(token, "move_note", { from: "Projects/Soup", to: "Kitchen" })).data.to).toBe("Kitchen");

    const listed = await call(token, "search_notes", { folder: "Kitchen" });
    expect(listed.data.notes.map((n: any) => n.path)).toEqual(["Kitchen/Plan.md"]);
    expect((await call(token, "search_notes", { query: "soup", folder: "Trips" })).data.results).toEqual([]);
    expect((await call(token, "search_notes", { folder: "Nope" })).result.isError).toBe(true);

    const styled = await call(token, "style_note", { path: "Plan", pinned: true, color: "teal" });
    expect(styled.data).toEqual({ path: "Kitchen/Plan.md", pinned: true, color: "teal" });

    await call(token, "trash_note", { path: "Kitchen" });
    expect((await call(token, "search_notes", { query: "soup" })).data.results).toEqual([]);
    const trash = await call(token, "list_trash");
    const item = trash.data.items.find((t: any) => t.original === "Kitchen");
    expect(item).toBeTruthy();
    expect((await call(token, "restore_from_trash", { trash_path: item.trash_path })).data.restored).toBe("Kitchen");
    expect((await call(token, "read_note", { path: "Kitchen/Plan.md" })).data.path).toBe("Kitchen/Plan.md");
    await call(token, "save_note", { title: "Menu", content: "# Menu\n\nFrom [[Plan]].\n" });
    expect((await call(token, "read_note", { path: "Kitchen/Plan.md" })).data.linked_from).toEqual(["Menu.md"]);
  });
});

describe("oauth for mcp connectors", () => {
  const verifier = "v".repeat(50);
  const listTools = (token: string) =>
    setup.app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  const form = (body: Record<string, string>, headers: Record<string, string> = {}) => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body).toString(),
  });
  const register = async (body: object) => setup.app.request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  /** Plays the connector: authorize as the signed-in user, approve, return the code. */
  async function approve(clientId: string, redirect: string, cookie: string, decision = "allow") {
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: s256(verifier), code_challenge_method: "S256", state: "xyz" });
    const consent = await setup.app.request(`/oauth/authorize?${q}`, { headers: { cookie } });
    expect(consent.status).toBe(200);
    const request = (await consent.text()).match(/name="request" value="([^"]+)"/)![1]!;
    const res = await setup.app.request("/oauth/authorize", form({ request, decision }, { cookie }));
    expect(res.status).toBe(302);
    return new URL(res.headers.get("location")!);
  }

  test("a consent can only be answered by the account it was shown to", async () => {
    const reg = (await (await register({ redirect_uris: ["https://claude.ai/cb"] })).json()) as any;
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "https://claude.ai/cb", code_challenge: s256(verifier), code_challenge_method: "S256" });
    const attacker = `sink_session=${setup.auth.issueToken("web", "someone-else")}`;
    const request = (await (await setup.app.request(`/oauth/authorize?${q}`, { headers: { cookie: attacker } })).text()).match(/name="request" value="([^"]+)"/)![1]!;
    const victim = `sink_session=${await login()}`;
    const res = await setup.app.request("/oauth/authorize", form({ request, decision: "allow" }, { cookie: victim }));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  test("hardening: no redirect before consent, access tokens expire, registration can't be used up", async () => {
    // A registered client with an attacker's redirect URI: bad requests show a page, never bounce there.
    const reg = (await (await register({ redirect_uris: ["https://evil.example/phish"] })).json()) as any;
    const bad = await setup.app.request(`/oauth/authorize?client_id=${reg.client_id}&response_type=x`);
    expect(bad.status).toBe(400);
    expect(bad.headers.get("location")).toBeNull();

    // An access token past its hour no longer works; a device token (no expiry) does.
    const subject = "sub-1";
    const mcp = setup.auth.issueToken("Test (MCP)", subject, "mcp", 60 * 60_000);
    expect(setup.auth.check(mcp)).not.toBeNull();
    setup.db.query("UPDATE tokens SET expires_at = ? WHERE id = ?").run(Date.now() - 1, setup.auth.verify(mcp)!);
    expect(setup.auth.check(mcp)).toBeNull();
    expect(setup.auth.check(setup.auth.issueToken("Phone", subject))).not.toBeNull();

    // One caller can only register a few clients an hour.
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await register({ redirect_uris: ["https://claude.ai/cb"] })).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  test("discovery, registration, consent, code + PKCE, refresh rotation", async () => {
    const unauth = await setup.app.request("/mcp", { method: "POST" });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`);
    const resource = (await (await setup.app.request("/.well-known/oauth-protected-resource/mcp")).json()) as any;
    expect(resource).toMatchObject({ resource: `${PUBLIC}/mcp`, authorization_servers: [PUBLIC] });
    const meta = (await (await setup.app.request("/.well-known/oauth-authorization-server")).json()) as any;
    expect(meta).toMatchObject({ issuer: PUBLIC, registration_endpoint: `${PUBLIC}/oauth/register`, code_challenge_methods_supported: ["S256"] });

    const redirect = "https://claude.ai/api/mcp/auth_callback";
    expect((await register({ redirect_uris: ["http://evil.example/cb"] })).status).toBe(400);
    const reg = await register({ redirect_uris: [redirect], client_name: "Claude" });
    expect(reg.status).toBe(201);
    const client = ((await reg.json()) as any).client_id;

    // Signed out: off to authentik, coming back to this exact authorize URL.
    const q = new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: redirect, code_challenge: s256(verifier), code_challenge_method: "S256" });
    const toLogin = await setup.app.request(`/oauth/authorize?${q}`);
    expect(toLogin.status).toBe(302);
    const loginUrl = new URL(toLogin.headers.get("location")!, PUBLIC);
    expect(loginUrl.pathname).toBe("/api/auth/oidc/start");
    expect(loginUrl.searchParams.get("next")).toBe(`/oauth/authorize?${q}`);
    // A registered client can't be sent somewhere else.
    expect((await setup.app.request(`/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(q), redirect_uri: "https://evil.example/" })}`)).status).toBe(400);

    const cookie = `sink_session=${await login()}`;
    const back = await approve(client, redirect, cookie);
    expect(back.origin + back.pathname).toBe(redirect);
    expect(back.searchParams.get("state")).toBe("xyz");
    const code = back.searchParams.get("code")!;

    expect((await setup.app.request("/oauth/token", form({ grant_type: "authorization_code", code, client_id: client, code_verifier: "w".repeat(50), redirect_uri: redirect }))).status).toBe(400);
    // That failed attempt burned the code.
    const code2 = (await approve(client, redirect, cookie)).searchParams.get("code")!;
    const tok = (await (await setup.app.request("/oauth/token", form({ grant_type: "authorization_code", code: code2, client_id: client, code_verifier: verifier, redirect_uri: redirect }))).json()) as any;
    expect(tok.token_type).toBe("Bearer");
    expect((await listTools(tok.access_token)).status).toBe(200);
    expect((await setup.app.request("/oauth/token", form({ grant_type: "authorization_code", code: code2, client_id: client, code_verifier: verifier }))).status).toBe(400);

    const names = setup.auth.listTokens("abc123").map((t: any) => t.name);
    expect(names).toContain("Claude (MCP)");

    const refreshed = (await (await setup.app.request("/oauth/token", form({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: client }))).json()) as any;
    expect((await listTools(refreshed.access_token)).status).toBe(200);
    expect((await listTools(tok.access_token)).status).toBe(401);
    expect((await setup.app.request("/oauth/token", form({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: client }))).status).toBe(400);

    await setup.app.request("/oauth/revoke", form({ token: refreshed.refresh_token }));
    expect((await listTools(refreshed.access_token)).status).toBe(401);
  });

  test("deny, confidential clients, and no open redirect after login", async () => {
    const cookie = `sink_session=${await login()}`;
    const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
    const reg = (await (await register({ redirect_uris: [redirect], client_name: "ChatGPT", token_endpoint_auth_method: "client_secret_basic" })).json()) as any;
    expect(reg.client_secret).toBeString();

    expect((await approve(reg.client_id, redirect, cookie, "deny")).searchParams.get("error")).toBe("access_denied");

    const code = (await approve(reg.client_id, redirect, cookie)).searchParams.get("code")!;
    const body = { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect };
    expect((await setup.app.request("/oauth/token", form({ ...body, client_id: reg.client_id }))).status).toBe(401);
    const basic = `Basic ${Buffer.from(`${reg.client_id}:${reg.client_secret}`).toString("base64")}`;
    const tok = (await (await setup.app.request("/oauth/token", form(body, { authorization: basic }))).json()) as any;
    expect((await listTools(tok.access_token)).status).toBe(200);

    const { callback } = await signIn(`client=web&next=${encodeURIComponent("/oauth/authorize?client_id=x&state=1")}`);
    expect(callback.headers.get("location")).toBe(`${PUBLIC}/oauth/authorize?client_id=x&state=1`);

    for (const next of ["//evil.example/", "/\\evil.example", "https://evil.example/"]) {
      expect((await setup.app.request(`/api/auth/oidc/start?next=${encodeURIComponent(next)}`)).status).toBe(400);
    }
  });
});

describe("backups", () => {
  test("one snapshot per day, oldest pruned, snapshot is a readable copy", async () => {
    const token = await login();
    await setup.app.request("/api/auth/tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "keep me" }),
    });
    const dir = mkdtempSync(join(tmpdir(), "sink-backup-"));
    const backups = new Backups(setup.db, dir, 2);
    const path = backups.run(new Date("2026-10-20T12:00:00Z"))!;
    expect(backups.run(new Date("2026-10-20T18:00:00Z"))).toBeNull();
    backups.run(new Date("2026-10-21T12:00:00Z"));
    backups.run(new Date("2026-10-22T12:00:00Z"));
    expect(readdirSync(dir).sort()).toEqual(["sink-2026-10-21.db", "sink-2026-10-22.db"]);

    const copy = new Database(join(dir, "sink-2026-10-22.db"), { readonly: true });
    expect(copy.query<{ name: string }, []>("SELECT name FROM tokens WHERE name = 'keep me'").get()!.name).toBe("keep me");
    copy.close();
    expect(path).toEndWith("sink-2026-10-20.db");
  });
});


describe("notes", () => {
  const send = (token: string, method: string, path: string, body?: unknown) =>
    setup.app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const file = (rel: string) => join(setup.vaultDir, rel);
  const q = (path: string) => `/api/notes/file?path=${encodeURIComponent(path)}`;

  test("an assistant can't turn an uploaded file into a public note by renaming it", async () => {
    const owner = await login();
    const mcp = setup.auth.issueToken("assistant", "abc123", "mcp");
    await send(owner, "PUT", "/api/publish", { handle: "sam" });
    const form = new FormData();
    form.append("file", new File(["---\npublish: true\n---\n# Leak\n\nprivate\n"], "leak.txt"));
    const up = await setup.app.request("/api/notes/attachments", { method: "POST", headers: { authorization: `Bearer ${mcp}` }, body: form });
    expect(up.status).toBe(201);
    const { path } = (await up.json()) as { path: string };
    expect((await send(mcp, "POST", "/api/notes/move", { from: path, to: "Leak.md" })).status).toBe(400);
    expect((await send(owner, "POST", "/api/notes/move", { from: path, to: "Leak.md" })).status).toBe(400);
    expect(existsSync(file("Leak.md"))).toBe(false);
    expect((await setup.app.request("/api/public/pages/sam/note?path=Leak.md")).status).toBe(404);
  });

  test("folders with emoji names move, trash and purge with everything in them", async () => {
    const token = await login();
    const F = "📚 Books";
    await send(token, "POST", "/api/notes", { folder: F, title: "Dune", content: "# Dune\n\npublic text\n" });
    const share = (await (await send(token, "POST", "/api/notes/share", { path: `${F}/Dune.md` })).json()) as { id: string };
    expect((await send(token, "POST", "/api/notes/move", { from: F, to: "Books" })).status).toBe(200);
    const paths = async () => (((await (await get(token, "/api/notes")).json()) as any).notes as { path: string }[]).map((n) => n.path).sort();
    expect(await paths()).toEqual(["Books/Dune.md"]);
    expect((await setup.app.request(`/api/public/share/${share.id}`)).status).toBe(200);

    // Trashed: gone from the list, and a new note at the old path doesn't inherit the share link.
    await send(token, "POST", "/api/notes/move", { from: "Books", to: F });
    expect((await send(token, "DELETE", q(F))).status).toBe(200);
    expect(await paths()).toEqual([]);
    await send(token, "POST", "/api/notes", { folder: F, title: "Dune", content: "# Dune\n\nNEW PRIVATE\n" });
    expect((await setup.app.request(`/api/public/share/${share.id}`)).status).toBe(404);

    // A note trashed today into a folder trashed long ago outlives the folder's purge.
    setup.db.query("UPDATE trash SET at = ?").run(Date.now() - 40 * 86_400_000);
    await send(token, "DELETE", q(`${F}/Dune.md`));
    await setup.vault.purgeTrash(30);
    expect(readdirSync(file(`.trash/${F}`)).some((n) => n.startsWith("Dune"))).toBe(true);
  });

  test("a note without a heading takes its new name when renamed", async () => {
    const token = await login();
    await send(token, "POST", "/api/notes", { folder: "", title: "Old name", content: "just text\n" });
    await send(token, "POST", "/api/notes/move", { from: "Old name.md", to: "New name.md" });
    expect(((await (await get(token, q("New name.md"))).json()) as any).title).toBe("New name");
  });

  test("a byte order mark doesn't hide the frontmatter", async () => {
    const token = await login();
    writeFileSync(file("Bom.md"), "﻿---\nsecret: hunter2\npinned: true\n---\n# Bom\n");
    await setup.vault.scan();
    const note = (await (await get(token, q("Bom.md"))).json()) as any;
    expect(note.pinned).toBe(true);
    const share = (await (await send(token, "POST", "/api/notes/share", { path: "Bom.md" })).json()) as { id: string };
    expect(((await (await setup.app.request(`/api/public/share/${share.id}`)).json()) as any).content).toBe("# Bom\n");
    // Changing a key keeps one frontmatter block, not a second one on top.
    expect((await send(token, "PATCH", "/api/notes/meta?path=Bom.md", { color: "red" })).status).toBe(200);
    const text = readFileSync(file("Bom.md"), "utf8");
    expect(text.match(/^﻿?---$/gm)?.length).toBe(2);
    expect(text).toContain("color: red");
  });

  test("renaming a note leaves path links to a different note with the same ending alone", async () => {
    const token = await login();
    await send(token, "POST", "/api/notes", { folder: "Notes", title: "todo", content: "root one\n" });
    await send(token, "POST", "/api/notes", { folder: "Work/Notes", title: "todo", content: "work one\n" });
    await send(token, "POST", "/api/notes", { folder: "", title: "Index", content: "See [[Notes/todo]] and [[Work/Notes/todo]].\n" });
    await send(token, "POST", "/api/notes/move", { from: "Work/Notes/todo.md", to: "Work/Notes/tasks.md" });
    expect(readFileSync(file("Index.md"), "utf8")).toBe("See [[Notes/todo]] and [[Work/Notes/tasks]].\n");
  });

  test("bad paths and long non-Latin titles are refused or fitted, not errors", async () => {
    const token = await login();
    expect((await get(token, `/api/notes/share?path=${encodeURIComponent("../x.md")}`)).status).toBe(400);
    expect((await send(token, "DELETE", `/api/notes/share?path=x.txt`)).status).toBe(400);
    const made = await send(token, "POST", "/api/notes", { folder: "", title: "漢".repeat(90), content: "# x\n" });
    expect(made.status).toBe(201);
    const { path } = (await made.json()) as { path: string };
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(210);
    // A name cut short never ends in half an emoji.
    expect(fileNameFor("a".repeat(99) + "😀")).toBe("a".repeat(99));
  });

  test("backlinks: wikilinks by name or path, aliases, headings, markdown links", async () => {
    const token = await login();
    const make = (folder: string, title: string, content: string) => send(token, "POST", "/api/notes", { folder, title, content });
    await make("Garden", "Soil", "# Soil\n\nLoam.\n");
    await make("", "Plan", "# Plan\n\nSee [[Soil]] first.\nUnrelated line.\nAlso [[soil#pH|the dirt]].\n");
    await make("Log", "Monday", "# Monday\n\nDug beds, per [[Garden/Soil]].\n");
    await make("", "Links", "# Links\n\n[soil notes](Garden/Soil.md)\n");
    await make("", "Other", "# Other\n\n[[Soil mix]] and [[Soils]] are different notes. https://x.y/Soil.md)\n");
    await make("", "Table", "# Table\n\n| Bed | Note |\n| --- | --- |\n| [[Garden/Soil\\|Soil]] | loam |\n");
    const res = await get(token, `/api/notes/backlinks?path=${encodeURIComponent("Garden/Soil.md")}`);
    const items = ((await res.json()) as any).items as { path: string; lines: string[] }[];
    expect(items.map((i) => i.path).sort()).toEqual(["Links.md", "Log/Monday.md", "Plan.md", "Table.md"]);
    expect(items.find((i) => i.path === "Plan.md")!.lines).toEqual(["See [[Soil]] first.", "Also [[soil#pH|the dirt]]."]);

    // A nested note: any end of its path, a markdown link with an anchor, frontmatter, non-ASCII capitals, its title.
    await make("Projects/Garden", "Église", "# Église\n\nOld stone. Links [[Église]] itself.\n");
    await make("", "Tour", "---\nup: \"[[Garden/Église]]\"\n---\n# Tour\n");
    await make("", "Map", "# Map\n\n[the church](../Projects/Garden/%C3%89glise.md#history)\n");
    await make("", "Diary", "# Diary\n\nVisited [[église]].\n");
    const nested = await get(token, `/api/notes/backlinks?path=${encodeURIComponent("/Projects/Garden/Église.md")}`);
    const paths = (((await nested.json()) as any).items as { path: string }[]).map((i) => i.path).sort();
    expect(paths).toEqual(["Diary.md", "Map.md", "Tour.md"]);

    // Edits and deletes keep the index in step.
    const plan = (await (await get(token, q("Plan.md"))).json()) as any;
    await send(token, "PUT", q("Plan.md"), { content: "# Plan\n\nNo links now.\n", base_hash: plan.hash });
    await send(token, "DELETE", q("Log/Monday.md"));
    const after = await get(token, `/api/notes/backlinks?path=${encodeURIComponent("Garden/Soil.md")}`);
    expect((((await after.json()) as any).items as { path: string }[]).map((i) => i.path).sort()).toEqual(["Links.md", "Table.md"]);
  });

  test("unlinked mentions: plain title and alias mentions, not links, code or frontmatter; linking keeps the hash rule", async () => {
    const token = await login();
    const make = (folder: string, title: string, content: string) => send(token, "POST", "/api/notes", { folder, title, content });
    const mentions = async (path: string) => ((await (await get(token, `/api/notes/mentions?path=${encodeURIComponent(path)}`)).json()) as any).items as any[];
    await make("Garden", "Église", "---\naliases: [Old church, Chapelle]\n---\n# Église\n\nStone.\n");
    await make("", "Diary", "# Diary\n\n- Visited the église today, then the old CHURCH.\n");
    await make("", "Linked", "# Linked\n\nThe [[Église]] is nice. Also église.\n");
    await make("", "Code", "# Code\n\nUse `église` here.\n\n```\nÉglise in a fence\n```\n[église](other.md) and https://x.y/église/ and [[x|église]]\n");
    await make("", "Front", "---\nnote: église\n---\n# Front\n\nNothing.\n");
    await make("", "Words", "# Words\n\nÉglises and églised are other words.\n");
    await make("", "Table", "# Table\n\n| Where | Note |\n| --- | --- |\n| Chapelle | x |\n");

    const items = await mentions("Garden/Église.md");
    expect(items.map((i) => i.path).sort()).toEqual(["Diary.md", "Linked.md", "Table.md"]);
    expect(items.find((i) => i.path === "Linked.md").mentions.map((m: any) => m.text)).toEqual(["église"]);
    const diary = items.find((i) => i.path === "Diary.md");
    // The alias "Old church" is two words, matched across the case difference.
    expect(diary.mentions.map((m: any) => m.text)).toEqual(["église", "old CHURCH"]);
    expect(diary.mentions[0]).toMatchObject({ before: "Visited the ", after: " today, then the old CHURCH." });

    // Linking: the exact title keeps its form, anything else becomes an alias; a stale hash is a conflict.
    const link = (body: object) => send(token, "POST", "/api/notes/mentions/link", { path: "Diary.md", target: "Garden/Église.md", base_hash: diary.hash, ...body });
    const stale = await link({ start: diary.mentions[1].start, text: "old CHURCH", base_hash: "0".repeat(64) });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as any).current.content).toContain("old CHURCH");
    expect((await link({ start: diary.mentions[1].start + 1, text: "ld CHURCH" })).status).toBe(409);
    const ok = await link({ start: diary.mentions[1].start, text: "old CHURCH" });
    expect(ok.status).toBe(200);
    expect(await Bun.file(file("Diary.md")).text()).toBe("# Diary\n\n- Visited the église today, then the [[Église|old CHURCH]].\n");
    // The old hash no longer matches: a second link from the same listing must not overwrite.
    expect((await link({ start: diary.mentions[0].start, text: "église" })).status).toBe(409);

    // A note that links here can still have other plain mentions.
    const fresh = (await mentions("Garden/Église.md")).find((i) => i.path === "Diary.md");
    expect(fresh.mentions.map((m: any) => m.text)).toEqual(["église"]);
    await link({ start: fresh.mentions[0].start, text: "église", base_hash: fresh.hash });
    expect(await Bun.file(file("Diary.md")).text()).toContain("Visited the [[Église|église]] today");
    expect((await mentions("Garden/Église.md")).map((i) => i.path).sort()).toEqual(["Linked.md", "Table.md"]);

    // In a table the alias's pipe is escaped.
    const table = (await mentions("Garden/Église.md")).find((i) => i.path === "Table.md");
    await link({ path: "Table.md", start: table.mentions[0].start, text: "Chapelle", base_hash: table.hash });
    expect(await Bun.file(file("Table.md")).text()).toContain("| [[Église\\|Chapelle]] | x |");

    expect(readFrontmatter("aliases:\n  - One two\n  - 'Three'\n").aliases).toEqual(["One two", "Three"]);
  });

  test("version previews drop list, task, quote and callout markers", async () => {
    const token = await login();
    const created = (await (await send(token, "POST", "/api/notes", { title: "Tasks", content: "# Tasks\n\n- [ ] one\n1. two\n> three\n> [!tip] four\n" })).json()) as any;
    await send(token, "PUT", q("Tasks.md"), { content: "# Tasks\n", base_hash: created.hash, keep_version: true });
    const items = ((await (await get(token, `/api/notes/versions?path=Tasks.md`)).json()) as any).items;
    expect(items[0].preview).toBe("one two three four");
  });

  test("version history: one per sitting, newest first, survives a rename, restorable", async () => {
    const token = await login();
    const created = (await (await send(token, "POST", "/api/notes", { title: "Essay", content: "# Essay\n\nv1\n" })).json()) as any;
    let hash = created.hash;
    const save = async (text: string) => {
      hash = ((await (await send(token, "PUT", q("Essay.md"), { content: text, base_hash: hash })).json()) as any).hash;
    };
    await save("# Essay\n\nv2\n");
    await save("# Essay\n\nv3\n"); // same sitting: no new version
    const list = async (path = "Essay.md") =>
      (((await (await get(token, `/api/notes/versions?path=${encodeURIComponent(path)}`)).json()) as any).items as any[]);
    expect((await list()).map((v) => v.preview)).toEqual(["v1"]);

    // Ten minutes later, the next save keeps what was there.
    setup.db.query("UPDATE versions SET at = at - 11 * 60000").run();
    await save("# Essay\n\nv4\n");
    expect((await list()).map((v) => v.preview)).toEqual(["v3", "v1"]);

    await send(token, "POST", "/api/notes/move", { from: "Essay.md", to: "Drafts/Essay.md" });
    const moved = await list("Drafts/Essay.md");
    expect(moved).toHaveLength(2);
    const old = (await (await get(token, `/api/notes/versions/${moved[1].id}?path=${encodeURIComponent("Drafts/Essay.md")}`)).json()) as any;
    expect(old.content).toBe("# Essay\n\nv1\n");
    // Restoring keeps what it replaces, even mid-sitting.
    const cur = (await (await get(token, q("Drafts/Essay.md"))).json()) as any;
    await send(token, "PUT", q("Drafts/Essay.md"), { content: old.content, base_hash: cur.hash, keep_version: true });
    expect((await list("Drafts/Essay.md")).map((v) => v.preview)).toEqual(["v4", "v3", "v1"]);
    // A write after a pause (another device, an assistant) keeps what was there, even soon after the last version.
    const now2 = (await (await get(token, q("Drafts/Essay.md"))).json()) as any;
    setup.db.query("UPDATE notes SET mtime = mtime - 3 * 60000 WHERE path = 'Drafts/Essay.md'").run();
    const phone = await send(token, "PUT", q("Drafts/Essay.md"), { content: "# Essay\n\nfrom the phone\n", base_hash: now2.hash });
    expect(phone.status).toBe(200);
    expect((await list("Drafts/Essay.md"))[0].preview).toBe("v1");

    // Deleting the note and putting it back keeps its history.
    const del = (await (await send(token, "DELETE", q("Drafts/Essay.md"))).json()) as any;
    await send(token, "POST", "/api/notes/trash/restore", { path: del.trashed_to });
    expect((await list("Drafts/Essay.md")).length).toBeGreaterThanOrEqual(4);

    // Boards keep no versions (their drawing JSON would fill the database).
    const board = (await (await send(token, "POST", "/api/notes", { title: "Sketch.excalidraw", content: "a" })).json()) as any;
    await send(token, "PUT", q(board.path), { content: "b", base_hash: board.hash, keep_version: true });
    expect(await list(board.path)).toEqual([]);

    // Another note's path can't read it.
    expect((await get(token, `/api/notes/versions/${moved[1].id}?path=Other.md`)).status).toBe(404);
  });

  test("share links: public read-only, only embedded images, follow moves, can be stopped", async () => {
    const token = await login();
    await send(token, "POST", "/api/notes", { folder: "Trips", title: "Lisbon", content: "---\nsecret: yes\n---\n# Lisbon\n\n![[map.png]]\n" });
    writeFileSync(file("map.png"), "png");
    writeFileSync(file("private.png"), "png");
    await send(token, "POST", "/api/notes/scan");
    const share = (await (await send(token, "POST", "/api/notes/share", { path: "Trips/Lisbon.md" })).json()) as any;
    expect(share.id).toHaveLength(22);
    // Sharing again gives the same link.
    expect(((await (await send(token, "POST", "/api/notes/share", { path: "Trips/Lisbon.md" })).json()) as any).id).toBe(share.id);

    const pub = await setup.app.request(`/api/public/share/${share.id}`);
    expect(pub.status).toBe(200);
    expect(pub.headers.get("x-robots-tag")).toContain("noindex");
    const body = (await pub.json()) as any;
    expect(body.title).toBe("Lisbon");
    expect(body.content).not.toContain("secret");
    expect((await setup.app.request(`/api/public/share/${share.id}/attachment?name=map.png`)).status).toBe(200);
    expect((await setup.app.request(`/api/public/share/${share.id}/attachment?name=private.png`)).status).toBe(404);
    expect((await setup.app.request("/api/public/share/nope")).status).toBe(404);

    await send(token, "POST", "/api/notes/move", { from: "Trips/Lisbon.md", to: "Lisbon.md" });
    expect((await setup.app.request(`/api/public/share/${share.id}`)).status).toBe(200);
    expect(((await (await get(token, "/api/notes/share?path=Lisbon.md")).json()) as any).id).toBe(share.id);

    await send(token, "DELETE", "/api/notes/share?path=Lisbon.md");
    expect((await setup.app.request(`/api/public/share/${share.id}`)).status).toBe(404);
  });

  test("editable share links: edit the body, keep frontmatter, conflicts, name recorded, can be turned off", async () => {
    const token = await login();
    await send(token, "POST", "/api/notes", { folder: "", title: "Plan", content: "---\nsecret: yes\n---\n# Plan\n" });
    const share = (await (await send(token, "POST", "/api/notes/share", { path: "Plan.md" })).json()) as any;
    expect(share.editable).toBe(false);
    const put = (body: object) =>
      setup.app.request(`/api/public/share/${share.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const read = async () => (await (await setup.app.request(`/api/public/share/${share.id}`)).json()) as any;
    // Read-only: no hash handed out, and edits are refused.
    expect((await read()).hash).toBeUndefined();
    expect((await put({ content: "# Hacked\n", base_hash: "x", name: "Sam" })).status).toBe(404);

    expect(((await (await send(token, "POST", "/api/notes/share", { path: "Plan.md", editable: true })).json()) as any).editable).toBe(true);
    const pub = await read();
    expect(pub.editable).toBe(true);
    expect((await put({ content: "# Plan\n\nBy Sam\n", base_hash: pub.hash, name: "  " })).status).toBe(400);
    const saved = await put({ content: "# Plan\n\nBy Sam\n", base_hash: pub.hash, name: "Sam" });
    expect(saved.status).toBe(200);
    expect(((await (await get(token, "/api/notes/file?path=Plan.md")).json()) as any).content).toBe("---\nsecret: yes\n---\n# Plan\n\nBy Sam\n");
    const conflict = await put({ content: "# Plan\n\nStale\n", base_hash: pub.hash, name: "Alex" });
    expect(conflict.status).toBe(409);
    const current = ((await conflict.json()) as any).current;
    expect(current.content).toBe("# Plan\n\nBy Sam\n");
    expect(current.hash).toBe(((await saved.json()) as any).hash);
    const info = (await (await get(token, "/api/notes/share?path=Plan.md")).json()) as any;
    expect(info.edited_by).toBe("Sam");
    expect(info.edited_at).toBeGreaterThan(0);
    // The text Sam replaced is in the history.
    const versions = ((await (await get(token, "/api/notes/versions?path=Plan.md")).json()) as any).items;
    expect(((await (await get(token, `/api/notes/versions/${versions[0].id}?path=Plan.md`)).json()) as any).content).toBe("---\nsecret: yes\n---\n# Plan\n");

    await send(token, "POST", "/api/notes/share", { path: "Plan.md", editable: false });
    expect((await put({ content: "# Again\n", base_hash: current.hash, name: "Sam" })).status).toBe(404);
  });

  test("a share link goes into the trash with its note, and comes back with it", async () => {
    const token = await login();
    await send(token, "POST", "/api/notes", { folder: "", title: "Ideas", content: "# Ideas\n" });
    const share = (await (await send(token, "POST", "/api/notes/share", { path: "Ideas.md", editable: true })).json()) as any;
    await send(token, "DELETE", q("Ideas.md"));
    expect((await setup.app.request(`/api/public/share/${share.id}`)).status).toBe(404);
    // A new note with the old name doesn't inherit the link (or the history).
    await send(token, "POST", "/api/notes", { folder: "", title: "Ideas", content: "# Ideas\n\nPrivate.\n" });
    expect((await setup.app.request(`/api/public/share/${share.id}`)).status).toBe(404);
    expect(((await (await get(token, "/api/notes/share?path=Ideas.md")).json()) as any).id).toBeNull();

    const restored = (await (await send(token, "POST", "/api/notes/trash/restore", { path: "Ideas.md" })).json()) as any;
    expect(restored.path).toBe("Ideas 1.md");
    expect(((await (await get(token, "/api/notes/share?path=Ideas%201.md")).json()) as any).id).toBe(share.id);
    expect(((await (await setup.app.request(`/api/public/share/${share.id}`)).json()) as any).content).toBe("# Ideas\n");

    // Deleted for good, the link goes too.
    await send(token, "DELETE", q("Ideas 1.md"));
    await send(token, "DELETE", "/api/notes/trash?path=Ideas%201.md");
    expect(setup.db.query("SELECT count(*) AS n FROM shares").get()).toEqual({ n: 0 });
  });

  test("the trash purge keeps the history of notes it can still restore", async () => {
    const token = await login();
    await send(token, "POST", "/api/notes", { folder: "", title: "Old", content: "# Old\n" });
    const day = 24 * 60 * 60 * 1000;
    setup.db.query("INSERT INTO versions (path, at, content) VALUES (?, ?, ?)").run("Old.md", Date.now() - 60 * day, "# Older\n");
    await send(token, "DELETE", q("Old.md"));
    await setup.vault.purgeTrash(30);
    expect(setup.db.query("SELECT count(*) AS n FROM versions").get()).toEqual({ n: 1 });
    await setup.vault.purgeTrash(30, Date.now() + 31 * day);
    expect(setup.db.query("SELECT count(*) AS n FROM versions").get()).toEqual({ n: 0 });
  });

  test("an editable share can't add images or properties", async () => {
    const token = await login();
    await send(token, "POST", "/api/notes", { folder: "", title: "Open", content: "# Open\n\n![[map.png]]\n" });
    writeFileSync(file("secret.png"), "png");
    await send(token, "POST", "/api/notes/scan");
    const share = (await (await send(token, "POST", "/api/notes/share", { path: "Open.md", editable: true })).json()) as any;
    const put = (content: string, base_hash: string) =>
      setup.app.request(`/api/public/share/${share.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, base_hash, name: "Sam" }) });
    const { hash } = (await (await setup.app.request(`/api/public/share/${share.id}`)).json()) as any;
    expect((await put("# Open\n\n![[map.png]]\n![](secret.png)\n", hash)).status).toBe(400);
    expect((await setup.app.request(`/api/public/share/${share.id}/attachment?name=secret.png`)).status).toBe(404);
    expect((await put("---\npublish: true\n---\n# Open\n", hash)).status).toBe(400);
    // Taking an image out is fine.
    expect((await put("# Open\n", hash)).status).toBe(200);
  });

  test("an editable share can't extend frontmatter that has no newline after it", async () => {
    const token = await login();
    writeFileSync(file("Bare.md"), "---\ntags: a\n---");
    await send(token, "POST", "/api/notes/scan");
    const share = (await (await send(token, "POST", "/api/notes/share", { path: "Bare.md", editable: true })).json()) as any;
    const { hash } = (await (await setup.app.request(`/api/public/share/${share.id}`)).json()) as any;
    const res = await setup.app.request(`/api/public/share/${share.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x\npublish: true\n---\nhello", base_hash: hash, name: "Sam" }),
    });
    expect(res.status).toBe(200);
    expect(readFileSync(file("Bare.md"), "utf8")).toBe("---\ntags: a\n---\nx\npublish: true\n---\nhello");
    expect((await (await send(token, "GET", q("Bare.md"))).json() as any).publish).toBeFalsy();
  });

  test("purging an old trashed folder keeps a note trashed into it since", async () => {
    mkdirSync(file("A"));
    writeFileSync(file("A/x.md"), "x");
    await setup.vault.scan();
    await setup.vault.trash("A");
    mkdirSync(file("A"));
    writeFileSync(file("A/y.md"), "y");
    await setup.vault.scan();
    const later = Date.now() + 20 * 86_400_000;
    setup.db.query("UPDATE trash SET at = ? WHERE path = 'A'").run(Date.now() - 20 * 86_400_000);
    await setup.vault.trash("A/y.md");
    expect(await setup.vault.purgeTrash(30, later)).toBe(1);
    expect(existsSync(file(".trash/A/x.md"))).toBe(false);
    expect(readFileSync(file(".trash/A/y.md"), "utf8")).toBe("y");
    expect(setup.db.query("SELECT path FROM trash").all()).toEqual([{ path: "A/y.md" }]);
  });

  test("two saves on the same version: one wins, the other is a conflict", async () => {
    const token = await login();
    const { hash } = (await (await send(token, "POST", "/api/notes", { folder: "", title: "Race", content: "# Race\n" })).json()) as any;
    const statuses = (await Promise.all(["# Race\n\nA\n", "# Race\n\nB\n"].map((content) => send(token, "PUT", q("Race.md"), { content, base_hash: hash })))).map((r) => r.status);
    expect(statuses.sort()).toEqual([200, 409]);
  });

  test("an assistant's token can't publish a note", async () => {
    const token = await login();
    const mcp = setup.auth.issueToken("assistant", "abc123", "mcp");
    await send(token, "POST", "/api/notes", { folder: "", title: "Diary", content: "# Diary\n" });
    expect((await send(mcp, "PATCH", "/api/notes/meta?path=Diary.md", { publish: true })).status).toBe(403);
    expect((await send(mcp, "PATCH", "/api/notes/meta?path=Diary.md", { pinned: true })).status).toBe(200);
    const pinned = ((await (await get(token, q("Diary.md"))).json()) as any).hash;
    expect((await send(mcp, "PUT", q("Diary.md"), { content: "---\npublish: true\n---\n# Diary\n", base_hash: pinned })).status).toBe(403);
    expect((await send(mcp, "POST", "/api/notes", { folder: "", title: "Out", content: "---\npublish: true\n---\n# Out\n" })).status).toBe(403);
    // A note you published stays editable by it.
    await send(token, "PATCH", "/api/notes/meta?path=Diary.md", { publish: true });
    const published = ((await (await get(token, q("Diary.md"))).json()) as any);
    expect((await send(mcp, "PUT", q("Diary.md"), { content: published.content + "\nMore.\n", base_hash: published.hash })).status).toBe(200);
    // Nor open a published note to search engines.
    const more = ((await (await get(token, q("Diary.md"))).json()) as any);
    const searchable = more.content.replace("publish: true", "publish: true\nsearchable: true");
    expect((await send(mcp, "PUT", q("Diary.md"), { content: searchable, base_hash: more.hash })).status).toBe(403);
    // Nor slip a note in as an upload.
    const form = new FormData();
    form.set("file", new File(["---\npublish: true\n---\n# Leak\n"], "Leak.md"));
    expect((await setup.app.request("/api/notes/attachments", { method: "POST", headers: { authorization: `Bearer ${mcp}` }, body: form })).status).toBe(400);
  });

  test("a file asked for by path is that file, even at the top level", async () => {
    const token = await login();
    mkdirSync(file("attachments"));
    writeFileSync(file("diagram.png"), "top");
    writeFileSync(file("attachments/diagram.png"), "attached");
    await send(token, "POST", "/api/notes/scan");
    expect(await (await get(token, "/api/notes/attachment?path=diagram.png")).text()).toBe("top");
    expect(await (await get(token, "/api/notes/attachment?name=diagram.png")).text()).toBe("attached");
  });

  test("moving or renaming a note updates links to it", async () => {
    const token = await login();
    const make = (folder: string, title: string, content: string) => send(token, "POST", "/api/notes", { folder, title, content });
    await make("Garden", "Soil", "# Soil\n");
    await make("", "Plan", "# Plan\n\n[[Soil]], [[soil#pH|the dirt]], ![[Garden/Soil]], [notes](Garden/Soil.md#top), [[Soils]], [[Other]]\n| [[Garden/Soil\\|Soil]] |\n");
    await send(token, "POST", "/api/notes/move", { from: "Garden/Soil.md", to: "Beds/Loam.md" });
    const plan = ((await (await get(token, q("Plan.md"))).json()) as any).content;
    expect(plan).toBe("# Plan\n\n[[Loam]], [[Loam#pH|the dirt]], ![[Beds/Loam]], [notes](Beds/Loam.md#top), [[Soils]], [[Other]]\n| [[Beds/Loam\\|Soil]] |\n");

    // A bare name another note also has is left alone: it may mean that one.
    await make("", "Loam", "# Loam (the other one)\n");
    await make("", "Mix", "# Mix\n\n[[Loam]] and [[Beds/Loam]]\n");
    await send(token, "POST", "/api/notes/move", { from: "Beds/Loam.md", to: "Beds/Clay.md" });
    expect(((await (await get(token, q("Mix.md"))).json()) as any).content).toBe("# Mix\n\n[[Loam]] and [[Beds/Clay]]\n");

    // A whole folder moving updates path links into it.
    await send(token, "POST", "/api/notes/move", { from: "Beds", to: "Garden/Beds" });
    expect(((await (await get(token, q("Mix.md"))).json()) as any).content).toBe("# Mix\n\n[[Loam]] and [[Garden/Beds/Clay]]\n");

    // The same for names with letters SQLite can't lower-case, and links that hold a path with spaces in `<…>`.
    await make("A", "Été", "# Été\n");
    await make("B", "Été", "# Été\n");
    await make("", "Old Note", "# Old Note\n");
    await make("", "Ref", "# Ref\n\n[[Été]] [x](<Old Note.md#Top>) [y](Old%20Note.md)\n");
    await send(token, "POST", "/api/notes/move", { from: "A/Été.md", to: "A/Summer.md" });
    await send(token, "POST", "/api/notes/move", { from: "Old Note.md", to: "New Note.md" });
    expect(((await (await get(token, q("Ref.md"))).json()) as any).content).toBe("# Ref\n\n[[Été]] [x](<New Note.md#Top>) [y](New%20Note.md)\n");
  });

  test("export: every note and attachment in a zip that unzips", async () => {
    const token = await login();
    await send(token, "POST", "/api/notes", { folder: "Ideas", title: "Garden", content: "# Garden\n\nRaised beds, cedar. ".repeat(20) });
    writeFileSync(file("photo.png"), "not really a png");
    const res = await get(token, "/api/notes/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("sink-notes-");
    const out = join(mkdtempSync(join(tmpdir(), "sink-zip-")), "x.zip");
    writeFileSync(out, new Uint8Array(await res.arrayBuffer()));
    const list = Bun.spawnSync(["unzip", "-Z1", out]).stdout.toString().trim().split("\n").sort();
    expect(list).toEqual(["Ideas/Garden.md", "photo.png"]);
    const text = Bun.spawnSync(["unzip", "-p", out, "Ideas/Garden.md"]).stdout.toString();
    expect(text).toBe("# Garden\n\nRaised beds, cedar. ".repeat(20));
    expect(Bun.spawnSync(["unzip", "-tq", out]).exitCode).toBe(0);
  });

  test("live events: a signed-in stream sees changes as they happen", async () => {
    const token = await login();
    expect((await setup.app.request("/api/events")).status).toBe(401);
    const res = await get(token, "/api/events");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    let seen = "";
    const until = async (needle: string) => {
      while (!seen.includes(needle)) seen += new TextDecoder().decode((await reader.read()).value);
    };
    await until("event: ready");
    await send(token, "POST", "/api/notes", { title: "Live", content: "# Live\n" });
    await until("Live.md");
    expect(seen).toContain('"type":"note.created"');
    await reader.cancel();
  });

  test("renaming only the case of a note works", async () => {
    const token = await login();
    await send(token, "POST", "/api/notes", { title: "shopping", content: "# shopping\n" });
    const res = await send(token, "POST", "/api/notes/move", { from: "shopping.md", to: "Shopping.md" });
    expect(res.status).toBe(200);
    expect(((await (await get(token, q("Shopping.md"))).json()) as any).path).toBe("Shopping.md");
    // A different note already at the destination still blocks the move.
    await send(token, "POST", "/api/notes", { title: "list", content: "x" });
    expect((await send(token, "POST", "/api/notes/move", { from: "list.md", to: "Shopping.md" })).status).toBe(409);
  });

  test("create, read, save with hash, conflicts, list, search", async () => {
    const token = await login();
    const a = (await (await send(token, "POST", "/api/notes", { folder: "Ideas", title: "Garden: beds?", content: "# Garden beds\n\nRaised #garden beds, cedar.\n" })).json()) as any;
    expect(a.path).toBe("Ideas/Garden beds.md");
    expect(a.title).toBe("Garden beds");
    expect(a.tags).toEqual(["garden"]);
    expect(readFileSync(file("Ideas/Garden beds.md"), "utf8")).toBe("# Garden beds\n\nRaised #garden beds, cedar.\n");
    // Same title again gets a number, like Obsidian's "Untitled 1".
    expect(((await (await send(token, "POST", "/api/notes", { folder: "Ideas", title: "Garden: beds?" })).json()) as any).path).toBe("Ideas/Garden beds 1.md");

    const read = (await (await get(token, q(a.path))).json()) as any;
    expect(read.hash).toBe(a.hash);
    const saved = (await (await send(token, "PUT", q(a.path), { content: read.content + "Order soil.\n", base_hash: read.hash })).json()) as any;
    expect(saved.hash).not.toBe(read.hash);

    // Stale hash: refused, and the reply carries the file as it is now.
    const stale = await send(token, "PUT", q(a.path), { content: "overwrite", base_hash: read.hash });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as any).current.content).toContain("Order soil.");
    expect((await send(token, "PUT", q(a.path), { content: "x", base_hash: null })).status).toBe(409);
    expect((await send(token, "PUT", q("Ideas/Gone.md"), { content: "x", base_hash: "abc" })).status).toBe(409);
    expect(readFileSync(file(a.path), "utf8")).toContain("Order soil.");

    const list = (await (await get(token, "/api/notes")).json()) as any;
    expect(list.notes.map((n: any) => n.path).sort()).toEqual(["Ideas/Garden beds 1.md", "Ideas/Garden beds.md"]);
    expect(list.folders).toEqual(["Ideas"]);
    const hits = (await (await get(token, "/api/notes?q=soil")).json()) as any;
    expect(hits.items.map((n: any) => n.path)).toEqual([a.path]);
    expect(hits.items[0].snippet).toContain("[soil]");
    expect((await get(token, q("Ideas/Nope.md"))).status).toBe(404);
  });

  test("card excerpts drop the title and end on a whole line", () => {
    expect(cardText("# Idea\n\nbody\n- item", "Idea")).toBe("body\n- item");
    const long = "x".repeat(390);
    expect(cardText(`${long}\n\n- Build a thing`, "t")).toBe(long);
    expect(cardText("y".repeat(500), "t")).toBe("y".repeat(400));
  });

  test("keep-style pin, colour and card excerpts live in frontmatter", async () => {
    const token = await login();
    await send(token, "POST", "/api/notes", { title: "Old", content: "# Old\nfirst" });
    const n = (await (await send(token, "POST", "/api/notes", { title: "Shopping", content: "# Shopping\n\n- [ ] eggs\n- [ ] oat milk\n" })).json()) as any;
    await send(token, "POST", "/api/notes", { title: "Newest", content: "newest" });

    const pinned = (await (await send(token, "PATCH", `/api/notes/meta?path=${encodeURIComponent(n.path)}`, { pinned: true, color: "yellow" })).json()) as any;
    expect(pinned).toMatchObject({ pinned: true, color: "yellow", title: "Shopping" });
    expect(readFileSync(file(n.path), "utf8")).toBe("---\npinned: true\ncolor: yellow\n---\n# Shopping\n\n- [ ] eggs\n- [ ] oat milk\n");

    const list = (await (await get(token, "/api/notes")).json()) as any;
    // Pinned first, whatever its age.
    expect(list.notes[0].title).toBe("Shopping");
    expect(list.notes.slice(1).map((x: any) => x.title).sort()).toEqual(["Newest", "Old"]);
    expect(list.notes[0].excerpt).toBe("- [ ] eggs\n- [ ] oat milk");
    expect(list.notes[0].image).toBeNull();
    expect((await send(token, "PATCH", `/api/notes/meta?path=${encodeURIComponent(n.path)}`, { color: "chartreuse" })).status).toBe(400);

    await send(token, "PATCH", `/api/notes/meta?path=${encodeURIComponent(n.path)}`, { pinned: false, color: null });
    expect(readFileSync(file(n.path), "utf8")).toBe("# Shopping\n\n- [ ] eggs\n- [ ] oat milk\n");
  });

  test("symlinks can't reach outside the vault", async () => {
    const token = await login();
    const outside = mkdtempSync(join(tmpdir(), "sink-outside-"));
    writeFileSync(join(outside, "secret.md"), "SINK_OIDC_CLIENT_SECRET=hunter2");
    symlinkSync(join(outside, "secret.md"), file("env.md"));
    symlinkSync(outside, file("Inbox"));
    writeFileSync(file("real.md"), "# Real");
    symlinkSync(file("real.md"), file("alias.md"));

    expect((await get(token, q("env.md"))).status).toBe(400);
    expect((await send(token, "PUT", q("env.md"), { content: "x", base_hash: "abc" })).status).toBe(400);
    expect((await send(token, "POST", "/api/notes", { folder: "Inbox", title: "Planted", content: "x" })).status).toBe(400);
    expect(existsSync(join(outside, "Planted.md"))).toBe(false);
    expect((await send(token, "POST", "/api/notes/move", { from: "real.md", to: "Inbox/real.md" })).status).toBe(400);
    expect(readFileSync(join(outside, "secret.md"), "utf8")).toBe("SINK_OIDC_CLIENT_SECRET=hunter2");
    // A link that stays inside the vault is just another way to the same note.
    expect(((await (await get(token, q("alias.md"))).json()) as any).title).toBe("Real");
  });

  test("paths are checked", async () => {
    const token = await login();
    for (const bad of ["../escape.md", "Ideas/../../x.md", ".obsidian/workspace.md", "a\\b.md", "notes.txt", "/", "Ideas/ .md"]) {
      expect((await send(token, "PUT", q(bad), { content: "x", base_hash: null })).status).toBe(400);
    }
    expect((await send(token, "POST", "/api/notes/move", { from: "a.md", to: "../a.md" })).status).toBe(400);
    expect((await send(token, "POST", "/api/notes", { folder: "../up", title: "x" })).status).toBe(400);
    expect(existsSync(join(setup.vaultDir, "..", "escape.md"))).toBe(false);
  });

  test("edits made outside Sink are found by a scan or a read", async () => {
    const token = await login();
    mkdirSync(file("Journal"), { recursive: true });
    writeFileSync(file("Journal/2026-10-29.md"), "---\ntags: [daily]\n---\nWrote this in Obsidian.\n");
    writeFileSync(file("Loose.md"), "loose");
    mkdirSync(file(".obsidian"));
    writeFileSync(file(".obsidian/hidden.md"), "not a note");
    mkdirSync(file("Empty"));
    expect(await setup.vault.scan()).toEqual({ added: 2, updated: 0, removed: 0, notes: 2 });
    let list = (await (await get(token, "/api/notes")).json()) as any;
    expect(list.notes.find((n: any) => n.path === "Journal/2026-10-29.md").tags).toEqual(["daily"]);
    expect(list.folders).toEqual(["Empty", "Journal"]);

    // Changed on disk: a read sees the new text and re-indexes before the next scan.
    writeFileSync(file("Loose.md"), "# Tidied\nnow with a heading");
    const read = (await (await get(token, q("Loose.md"))).json()) as any;
    expect(read.title).toBe("Tidied");
    expect(((await (await get(token, "/api/notes?q=heading")).json()) as any).items).toHaveLength(1);

    rmSync(file("Journal/2026-10-29.md"));
    const later = new Date(Date.now() + 5000);
    writeFileSync(file("Loose.md"), "# Tidied again");
    utimesSync(file("Loose.md"), later, later);
    expect(await setup.vault.scan()).toEqual({ added: 0, updated: 1, removed: 1, notes: 1 });
    expect(((await (await get(token, "/api/notes?q=obsidian")).json()) as any).items).toHaveLength(0);
  });

  test("move and trash notes and folders", async () => {
    const token = await login();
    await send(token, "POST", "/api/notes", { folder: "Work/Projects", title: "Sink", content: "# Sink\nnotes pivot" });
    await send(token, "POST", "/api/notes", { title: "Scratch", content: "scratch" });
    expect((await send(token, "POST", "/api/notes/move", { from: "Scratch.md", to: "Work/Scratch.md" })).status).toBe(200);
    expect(existsSync(file("Work/Scratch.md"))).toBe(true);
    expect((await send(token, "POST", "/api/notes/move", { from: "Work/Scratch.md", to: "Work/Projects/Sink.md" })).status).toBe(409);
    expect((await send(token, "POST", "/api/notes/move", { from: "Work", to: "Work/Inner" })).status).toBe(400);

    expect((await send(token, "POST", "/api/notes/move", { from: "Work/Projects", to: "Archive/Projects" })).status).toBe(200);
    const hits = (await (await get(token, "/api/notes?q=pivot")).json()) as any;
    expect(hits.items.map((n: any) => n.path)).toEqual(["Archive/Projects/Sink.md"]);
    expect(((await (await get(token, "/api/notes")).json()) as any).folders).toEqual(["Archive", "Archive/Projects", "Work"]);

    const t1 = (await (await send(token, "DELETE", q("Work/Scratch.md"))).json()) as any;
    expect(t1.trashed_to).toBe(".trash/Work/Scratch.md");
    await send(token, "POST", "/api/notes", { folder: "Work", title: "Scratch", content: "again" });
    expect(((await (await send(token, "DELETE", q("Work/Scratch.md"))).json()) as any).trashed_to).toBe(".trash/Work/Scratch 1.md");
    expect((await send(token, "DELETE", q("Archive"))).status).toBe(200);
    expect(existsSync(file(".trash/Archive/Projects/Sink.md"))).toBe(true);
    expect(((await (await get(token, "/api/notes")).json()) as any).notes).toEqual([]);
    // The trash stays out of the index.
    await setup.vault.scan();
    expect(((await (await get(token, "/api/notes")).json()) as any).notes).toEqual([]);
  });

  test("trash: list, restore, delete for good, empty, purge after a while", async () => {
    const token = await login();
    await send(token, "POST", "/api/notes", { folder: "Work", title: "Plan", content: "# Plan\nship it" });
    await send(token, "POST", "/api/notes", { folder: "Work/Old", title: "Notes", content: "# Notes\nold stuff" });
    await send(token, "DELETE", q("Work/Plan.md"));
    await send(token, "DELETE", q("Work/Old"));
    // Obsidian's own trash: listed, but never purged by Sink.
    mkdirSync(file(".trash"), { recursive: true });
    writeFileSync(file(".trash/From Obsidian.md"), "# From Obsidian");

    const items = ((await (await get(token, "/api/notes/trash")).json()) as any).items;
    expect(items.map((t: any) => [t.path, t.original, t.title]).sort()).toEqual([
      ["From Obsidian.md", "From Obsidian.md", "From Obsidian"],
      ["Work/Old/Notes.md", "Work/Old/Notes.md", "Notes"],
      ["Work/Plan.md", "Work/Plan.md", "Plan"],
    ]);
    expect(items.find((t: any) => t.path === "Work/Plan.md").excerpt).toBe("ship it");

    // Restore puts it back and in the index; a note made at the same path since gets a numbered sibling.
    await send(token, "POST", "/api/notes", { folder: "Work", title: "Plan", content: "new plan" });
    const back = (await (await send(token, "POST", "/api/notes/trash/restore", { path: ".trash/Work/Plan.md" })).json()) as any;
    expect(back.path).toBe("Work/Plan 1.md");
    expect(readFileSync(file("Work/Plan 1.md"), "utf8")).toBe("# Plan\nship it");
    expect(((await (await get(token, "/api/notes?q=ship")).json()) as any).items.map((n: any) => n.path)).toEqual(["Work/Plan 1.md"]);
    // A note trashed with its folder comes back into that folder.
    expect(((await (await send(token, "POST", "/api/notes/trash/restore", { path: "Work/Old/Notes.md" })).json()) as any).path).toBe("Work/Old/Notes.md");
    expect(existsSync(file(".trash/Work"))).toBe(false);
    expect((await send(token, "POST", "/api/notes/trash/restore", { path: "Work/Plan.md" })).status).toBe(404);
    expect((await send(token, "POST", "/api/notes/trash/restore", { path: "../sink.md" })).status).toBe(400);

    // Purge only removes what Sink trashed, once it's old enough.
    await send(token, "DELETE", q("Work/Plan 1.md"));
    expect(await setup.vault.purgeTrash(30)).toBe(0);
    expect(await setup.vault.purgeTrash(30, Date.now() + 31 * 86_400_000)).toBe(1);
    expect(existsSync(file(".trash/Work/Plan 1.md"))).toBe(false);
    expect(existsSync(file(".trash/From Obsidian.md"))).toBe(true);

    await send(token, "DELETE", q("Work/Old/Notes.md"));
    expect((await send(token, "DELETE", "/api/notes/trash?path=Work/Old/Notes.md")).status).toBe(200);
    expect(existsSync(file(".trash/Work/Old/Notes.md"))).toBe(false);
    expect((await send(token, "DELETE", "/api/notes/trash")).status).toBe(400);
    expect((await send(token, "DELETE", "/api/notes/trash?all=true")).status).toBe(200);
    expect(((await (await get(token, "/api/notes/trash")).json()) as any).items).toEqual([]);
    expect(existsSync(file(".trash/From Obsidian.md"))).toBe(false);
  });

  test("folders: create, rename, delete and restore a whole folder", async () => {
    const token = await login();
    expect((await send(token, "POST", "/api/notes/folders", { path: "Projects/Empty" })).status).toBe(201);
    expect(((await (await get(token, "/api/notes")).json()) as any).folders).toEqual(["Projects", "Projects/Empty"]);
    await send(token, "POST", "/api/notes", { folder: "Projects/Sink", title: "Plan", content: "# Plan\n- [ ] ship" });
    await send(token, "POST", "/api/notes", { folder: "Projects/Sink/Ideas", title: "Later", content: "# Later" });
    expect((await send(token, "POST", "/api/notes/move", { from: "Projects/Sink", to: "Work/Sink" })).status).toBe(200);
    const trashed = (await (await send(token, "DELETE", q("Work"))).json()) as any;
    expect(trashed.trashed_to).toBe(".trash/Work");
    expect(((await (await get(token, "/api/notes")).json()) as any).notes).toEqual([]);
    // Something else took the name meanwhile: the folder comes back numbered, not merged into it.
    await send(token, "POST", "/api/notes/folders", { path: "Work" });
    const back = (await (await send(token, "POST", "/api/notes/trash/restore", { path: "Work" })).json()) as any;
    expect(back).toEqual({ path: "Work 1", notes: 2 });
    const list = (await (await get(token, "/api/notes")).json()) as any;
    expect(list.notes.map((n: any) => n.path).sort()).toEqual(["Work 1/Sink/Ideas/Later.md", "Work 1/Sink/Plan.md"]);
    expect(list.folders).toEqual(expect.arrayContaining(["Work", "Work 1", "Work 1/Sink", "Work 1/Sink/Ideas"]));
    expect(((await (await get(token, "/api/todos")).json()) as any).todos.map((t: any) => t.path)).toEqual(["Work 1/Sink/Plan.md"]);
    expect(((await (await get(token, "/api/notes/trash")).json()) as any).items).toEqual([]);
  });

  test("attachments: upload, embed by name, served without script", async () => {
    const token = await login();
    const upload = async (name: string, bytes: Uint8Array | string) => {
      const form = new FormData();
      form.set("file", new File([bytes], name));
      return setup.app.request("/api/notes/attachments", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
    };
    const first = (await (await upload("photo.png", png)).json()) as any;
    expect(first).toEqual({ path: "attachments/photo.png", embed: "![[photo.png]]" });
    expect(((await (await upload("photo.png", png)).json()) as any).path).toBe("attachments/photo 1.png");

    const byName = await get(token, "/api/notes/attachment?name=photo.png");
    expect(byName.status).toBe(200);
    expect(byName.headers.get("content-type")).toBe("image/png");
    expect(byName.headers.get("content-security-policy")).toContain("sandbox");

    await upload("evil.svg", "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    expect((await get(token, "/api/notes/attachment?name=evil.svg")).headers.get("content-security-policy")).toStartWith("sandbox");
    await upload("page.html", "<script>alert(1)</script>");
    const html = await get(token, "/api/notes/attachment?path=attachments/page.html");
    expect(html.headers.get("content-type")).toBe("application/octet-stream");
    expect(html.headers.get("content-disposition")).toContain("attachment");
    expect((await get(token, "/api/notes/attachment?path=../sink.db")).status).toBe(404);
  });

  test("parsing: titles, frontmatter tags, inline tags, names", () => {
    expect(parseNote("a/My file.md", "no heading").title).toBe("My file");
    expect(parseNote("x.md", "---\ntitle: \"From FM\"\n---\nbody").title).toBe("From FM");
    expect(parseNote("x.md", "---\ntitle: FM\n---\n# Heading wins ##\n").title).toBe("Heading wins");
    expect(readFrontmatter("tags:\n  - one\n  - '#two'\nother: 1").tags).toEqual(["one", "two"]);
    expect(readFrontmatter("tags: a, b").tags).toEqual(["a", "b"]);
    expect(inlineTags("#real and `#code` and #123 and #nested/tag/ and a#not\n```\n#fenced\n```")).toEqual(["real", "nested/tag"]);
    expect(parseNote("x.md", "---\ntags: [Work]\n---\n#work #home").tags).toEqual(["Work", "home"]);
    expect(fileNameFor("  a/b: c?  ")).toBe("a b c");
    expect(fileNameFor("...")).toBe("Untitled");
    expect(cleanPath("/Inbox/x.md/", "note")).toBe("Inbox/x.md");
  });
});

describe("todos", () => {
  const send = (token: string, method: string, path: string, body?: unknown) =>
    setup.app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  test("parses Tasks syntax, skipping frontmatter and code", () => {
    const md = [
      "---",
      "- [ ] not a task, frontmatter",
      "---",
      "- [ ] Pay rates 📅 2026-11-02 ⏫",
      "  * [x] Book flights ✅ 2026-10-20",
      "1. [-] Cancelled thing",
      "- [/] Half done 🔁 every week 📅 2026-11-09",
      "- [ ] Call mum (@2026-10-30 18:00)",
      "```",
      "- [ ] in code",
      "```",
      "- [] not a task",
    ].join("\n");
    const todos = parseTodos(md, "America/New_York");
    expect(todos.map((t) => [t.line, t.text, t.status, t.due, t.done_on])).toEqual([
      [3, "Pay rates", "open", "2026-11-02", null],
      [4, "Book flights", "done", null, "2026-10-20"],
      [5, "Cancelled thing", "cancelled", null, null],
      [6, "Half done", "open", "2026-11-09", null],
      [7, "Call mum", "open", "2026-10-30", null],
    ]);
    // Due date alone reminds at 9am local; a reminder time wins. New York leaves daylight saving on 1 November.
    expect(new Date(todos[0]!.remind_at!).toISOString()).toBe("2026-11-02T14:00:00.000Z");
    expect(new Date(todos[4]!.remind_at!).toISOString()).toBe("2026-10-30T22:00:00.000Z");
    expect(setDone("- [ ] Pay rates 📅 2026-11-02", true, "2026-10-29")).toBe("- [x] Pay rates 📅 2026-11-02 ✅ 2026-10-29");
    expect(setDone("  - [x] Book ✅ 2026-10-20", false, "2026-10-29")).toBe("  - [ ] Book");
    expect(todoLine("  milk  ", "2026-11-01", "08:30")).toBe("- [ ] milk 📅 2026-11-01 (@2026-11-01 08:30)");
  });

  test("list, tick, untick, quick add, and they follow their note", async () => {
    const token = await login();
    await send(token, "POST", "/api/notes", { folder: "Trips", title: "Japan", content: "# Japan\n\n- [ ] passport 📅 2026-11-20\n- [ ] yen\n" });
    const added = (await (await send(token, "POST", "/api/todos", { text: "milk", due: "2026-11-01" })).json()) as any;
    expect(added).toMatchObject({ path: "Todo.md", raw: "- [ ] milk 📅 2026-11-01" });
    await send(token, "POST", "/api/todos", { text: "bread" });
    expect(readFileSync(join(setup.vaultDir, "Todo.md"), "utf8")).toBe("# Todo\n\n- [ ] milk 📅 2026-11-01\n- [ ] bread\n");

    let open = ((await (await get(token, "/api/todos")).json()) as any).todos;
    // Dated first, soonest first; then the rest.
    expect(open.slice(0, 2).map((t: any) => t.text)).toEqual(["milk", "passport"]);
    expect(open.slice(2).map((t: any) => t.text).sort()).toEqual(["bread", "yen"]);
    expect(open.find((t: any) => t.text === "passport").note_title).toBe("Japan");

    const passport = open.find((t: any) => t.text === "passport");
    // Someone added a line above it since the list loaded: the same text is still found.
    const note = (await (await get(token, "/api/notes/file?path=Trips%2FJapan.md")).json()) as any;
    await send(token, "PUT", "/api/notes/file?path=Trips%2FJapan.md", { content: note.content.replace("\n\n", "\n\n- [ ] jr pass\n"), base_hash: note.hash });
    const ticked = (await (await send(token, "POST", "/api/todos/toggle", { path: passport.path, line: passport.line, raw: passport.raw, done: true })).json()) as any;
    expect(ticked.line).toBe(passport.line + 1);
    expect(ticked.raw).toStartWith("- [x] passport 📅 2026-11-20 ✅ ");
    const done = ((await (await get(token, "/api/todos?view=done")).json()) as any).todos;
    expect(done.map((t: any) => t.text)).toEqual(["passport"]);
    expect((await send(token, "POST", "/api/todos/toggle", { path: passport.path, line: 0, raw: "- [ ] gone", done: true })).status).toBe(409);
    const unticked = (await (await send(token, "POST", "/api/todos/toggle", { path: passport.path, line: ticked.line, raw: ticked.raw, done: false })).json()) as any;
    expect(unticked.raw).toBe("- [ ] passport 📅 2026-11-20");

    await send(token, "POST", "/api/notes/move", { from: "Trips", to: "Travel" });
    open = ((await (await get(token, "/api/todos")).json()) as any).todos;
    expect(open.filter((t: any) => t.path === "Travel/Japan.md")).toHaveLength(3);
    await send(token, "DELETE", "/api/notes/file?path=Travel");
    open = ((await (await get(token, "/api/todos")).json()) as any).todos;
    expect(open.map((t: any) => t.text)).toEqual(["milk", "bread"]);
  });

  test("recurring todos: next dates, and the next copy's line", () => {
    expect(nextDate("every day", "2026-10-31")).toBe("2026-11-01");
    expect(nextDate("every 2 weeks", "2026-10-30")).toBe("2026-11-13");
    expect(nextDate("every month", "2026-01-31")).toBe("2026-02-28");
    expect(nextDate("every year", "2028-02-29")).toBe("2029-02-28");
    // 30 October 2026 is a Friday.
    expect(nextDate("every weekday", "2026-10-30")).toBe("2026-11-02");
    expect(nextDate("every Monday, Thursday", "2026-10-30")).toBe("2026-11-02");
    expect(nextDate("every week on Friday", "2026-10-30")).toBe("2026-11-06");
    expect(nextDate("every full moon", "2026-10-30")).toBeNull();

    expect(nextOccurrence("  - [ ] Bins 🔁 every week 📅 2026-10-30 (@2026-10-30 19:00)", "2026-11-01")).toBe(
      "  - [ ] Bins 🔁 every week 📅 2026-11-06 (@2026-11-06 19:00)",
    );
    // "when done" counts from today; the start date moves with the due date.
    expect(nextOccurrence("- [ ] Haircut 🔁 every 4 weeks when done 🛫 2026-10-01 📅 2026-10-05", "2026-10-30")).toBe(
      "- [ ] Haircut 🔁 every 4 weeks when done 🛫 2026-11-23 📅 2026-11-27",
    );
    expect(nextOccurrence("- [ ] Water plants 🔁 every 3 days", "2026-10-30")).toBe("- [ ] Water plants 🔁 every 3 days");
    // Dated only by its reminder: that moves on too.
    expect(nextOccurrence("- [ ] Call mum 🔁 every week (@2026-10-30 18:00)", "2026-11-01")).toBe("- [ ] Call mum 🔁 every week (@2026-11-06 18:00)");
    expect(nextOccurrence("- [ ] One-off 📅 2026-10-30", "2026-10-30")).toBeNull();
    // The block id stays on the ticked line, so links to it still mean one line.
    expect(nextOccurrence("- [ ] Bins 🔁 every week 📅 2026-11-02 ^bins", "2026-11-02")).toBe("- [ ] Bins 🔁 every week 📅 2026-11-09");
  });

  test("editTodo changes text, date and time, keeping the other fields", () => {
    const raw = "- [ ] Pay rates ⏫ 🔁 every month 📅 2026-11-02 (@2026-11-02 18:00) ^rates";
    expect(editTodo(raw, { text: "Pay council rates" })).toBe("- [ ] Pay council rates ⏫ 🔁 every month 📅 2026-11-02 (@2026-11-02 18:00) ^rates");
    // Moving the date keeps the reminder's time.
    expect(editTodo(raw, { due: "2026-11-03" })).toBe("- [ ] Pay rates ⏫ 🔁 every month 📅 2026-11-03 (@2026-11-03 18:00) ^rates");
    expect(editTodo(raw, { time: null })).toBe("- [ ] Pay rates ⏫ 🔁 every month 📅 2026-11-02 ^rates");
    expect(editTodo(raw, { due: null })).toBe("- [ ] Pay rates ⏫ 🔁 every month ^rates");
    expect(editTodo("* [ ] milk", { due: "2026-11-01", time: "8:30" })).toBe("* [ ] milk 📅 2026-11-01 (@2026-11-01 8:30)");
  });

  test("ticking a recurring todo adds the next one; undo takes it back out; edit rewrites the line", async () => {
    const token = await login();
    const file = join(setup.vaultDir, "Home.md");
    await setup.vault.write("Home.md", "# Home\n\n- [ ] Bins 🔁 every week 📅 2026-10-30\n- [ ] Milk\n", null);
    const ticked = (await (
      await send(token, "POST", "/api/todos/toggle", { path: "Home.md", line: 2, raw: "- [ ] Bins 🔁 every week 📅 2026-10-30", done: true })
    ).json()) as any;
    expect(ticked.line).toBe(3);
    expect(ticked.next).toBe("- [ ] Bins 🔁 every week 📅 2026-11-06");
    expect(readFileSync(file, "utf8")).toStartWith("# Home\n\n- [ ] Bins 🔁 every week 📅 2026-11-06\n- [x] Bins 🔁 every week 📅 2026-10-30 ✅ ");
    await send(token, "POST", "/api/todos/toggle", { path: "Home.md", line: ticked.line, raw: ticked.raw, done: false, next: ticked.next });
    expect(readFileSync(file, "utf8")).toBe("# Home\n\n- [ ] Bins 🔁 every week 📅 2026-10-30\n- [ ] Milk\n");

    const edited = (await (
      await send(token, "POST", "/api/todos/edit", { path: "Home.md", line: 3, raw: "- [ ] Milk", text: "Oat milk", due: "2026-11-01", time: "17:00" })
    ).json()) as any;
    expect(edited).toEqual({ ok: true, line: 3, raw: "- [ ] Oat milk 📅 2026-11-01 (@2026-11-01 17:00)" });
    const open = ((await (await get(token, "/api/todos")).json()) as any).todos;
    expect(open.find((t: any) => t.text === "Oat milk").due).toBe("2026-11-01");
    expect((await send(token, "POST", "/api/todos/edit", { path: "Home.md", line: 3, raw: "- [ ] Milk", due: null })).status).toBe(409);
    expect((await send(token, "POST", "/api/todos/edit", { path: "Home.md", line: 0, raw: "# Home", text: "x" })).status).toBe(400);
  });

  test("priority, start and scheduled dates; cancelling", () => {
    const [a, b, c] = parseTodos(
      ["- [ ] Taxes ⏫ 🛫 2026-11-01 📅 2026-11-30", "- [ ] Garden ⏳ 2026-11-05 🔽", "- [-] Old plan ❌ 2026-10-01"].join("\n"),
      "UTC",
    );
    expect([a!.priority, a!.start, a!.due]).toEqual([1, "2026-11-01", "2026-11-30"]);
    // A scheduled date dates a todo with no due date.
    expect([b!.priority, b!.scheduled, b!.due]).toEqual([4, "2026-11-05", "2026-11-05"]);
    expect([c!.status, c!.done_on]).toEqual(["cancelled", "2026-10-01"]);
    expect(setStatus("- [ ] Old plan ✅ 2026-10-01", "cancelled", "2026-10-30")).toBe("- [-] Old plan ❌ 2026-10-30");
    expect(setDone("- [-] Old plan ❌ 2026-10-01", false, "2026-10-30")).toBe("- [ ] Old plan");
    // Rescheduling a scheduled-only todo moves its scheduled date.
    expect(editTodo("- [ ] Garden ⏳ 2026-11-05 🔽", { due: "2026-11-07" })).toBe("- [ ] Garden 🔽 ⏳ 2026-11-07");
  });

  test("quick add reads a date, time or repeat off the end", () => {
    // 30 October 2026 is a Friday.
    const q = (s: string) => parseQuick(s, "2026-10-30");
    expect(q("call mum tomorrow 6pm")).toEqual({ text: "call mum", due: "2026-10-31", time: "18:00", every: undefined });
    expect(q("dentist on 3 nov at 2:30pm")).toMatchObject({ text: "dentist", due: "2026-11-03", time: "14:30" });
    expect(q("rates fri").due).toBe("2026-10-30");
    expect(q("rates next fri").due).toBe("2026-11-06");
    expect(q("party jan 3").due).toBe("2027-01-03");
    expect(q("rent 31 feb")).toMatchObject({ text: "rent 31 feb", due: undefined });
    expect(q("party 29 feb").due).toBe("2028-02-29");
    expect(q("report in 2 weeks").due).toBe("2026-11-13");
    expect(q("drinks tonight")).toMatchObject({ text: "drinks", due: "2026-10-30", time: "19:00" });
    expect(q("call bank at 16:00")).toMatchObject({ text: "call bank", due: "2026-10-30", time: "16:00" });
    expect(q("bins every tuesday")).toMatchObject({ text: "bins", every: "every tuesday", due: "2026-11-03" });
    expect(q("stretch every day")).toMatchObject({ every: "every day", due: "2026-10-30" });
    expect(q("read Monday notes")).toEqual({ text: "read Monday notes" });
    expect(q("tomorrow")).toEqual({ text: "tomorrow" });
    expect(todoLine("bins", "2026-11-03", "19:00", "every tuesday")).toBe("- [ ] bins 🔁 every tuesday 📅 2026-11-03 (@2026-11-03 19:00)");
  });

  test("natural quick add, cancel through edit, and the badge count", async () => {
    const token = await login();
    const today = ((await (await get(token, "/api/todos")).json()) as any).today as string;
    const added = (await (await send(token, "POST", "/api/todos", { text: "pay rates today 5pm", natural: true })).json()) as any;
    expect(added).toMatchObject({ raw: `- [ ] pay rates 📅 ${today} (@${today} 17:00)`, due: today, time: "17:00" });
    // Without natural (assistants, email), the text is kept as written.
    expect(((await (await send(token, "POST", "/api/todos", { text: "plan today" })).json()) as any).raw).toBe("- [ ] plan today");
    await setup.vault.write("Old.md", "- [ ] late 📅 2020-01-01\n- [ ] not yet 🛫 2999-01-01 📅 2020-01-01\n", null);
    expect(await (await get(token, "/api/todos/count")).json()).toEqual({ overdue: 1, today: 1 });
    const cancelled = (await (await send(token, "POST", "/api/todos/edit", { path: "Old.md", line: 0, raw: "- [ ] late 📅 2020-01-01", status: "cancelled" })).json()) as any;
    expect(cancelled.raw).toBe(`- [-] late 📅 2020-01-01 ❌ ${today}`);
    expect(await (await get(token, "/api/todos/count")).json()).toEqual({ overdue: 0, today: 1 });
  });

  test("excalidraw boards index by name, not drawing JSON", () => {
    const board = "---\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n---\n# Text Elements\nKitchen layout ^abc\n\n%%\n# Drawing\n```json\n{\"elements\":[{\"id\":\"zzz\"}]}\n```\n%%\n";
    const parsed = parseNote("Boards/House plan.excalidraw.md", board);
    expect(parsed.title).toBe("House plan");
    expect(parsed.body).toContain("Kitchen layout");
    expect(parsed.body).not.toContain("elements");
    expect(parseNote("b.excalidraw.md", "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu. ⚠== blah\n\n## Text Elements\nHi ^x\n").body).not.toContain("EXCALIDRAW VIEW");
  });
});

describe("helpers", () => {
  test("a title is the first heading outside code, closing hashes and all", () => {
    expect(parseNote("x.md", "# Learning C#\n").title).toBe("Learning C#");
    expect(parseNote("x.md", "# Closed ##\n").title).toBe("Closed");
    expect(parseNote("Server setup.md", "Steps:\n\n```bash\n# install deps\napt install foo\n```\n").title).toBe("Server setup");
  });

  test("a card's image is the first image the note embeds", () => {
    expect(firstImage("text\n![[Doc.pdf]]\n![[Photo 1.JPG|300]] ![[b.png]]")).toBe("Photo 1.JPG");
    expect(firstImage("![x](https://example.com/a.png) ![y](../Attachments/My%20pic.webp \"t\")")).toBe("Attachments/My pic.webp");
    expect(firstImage("![[Other note]] [link](a.png)")).toBeNull();
  });

  test("email HTML entities decode once, and bad code points don't throw", () => {
    expect(pageText("<body><p>a &amp;lt;b&amp;gt; &lt;i&gt; &#x41;&#66; &copy;x &#99999999;</p></body>")).toBe("a &lt;b&gt; <i> AB &copy;x");
  });

  test("dates are the user's wall clock", () => {
    const tz = "America/New_York";
    expect(localIso(new Date("2026-10-22T04:12:07Z"), tz)).toBe("2026-10-22T00:12:07-04:00");
    expect(utcOffset(new Date("2026-01-15T00:00:00Z"), tz)).toBe("-05:00");
    expect(localTime("2026-10-30", tz)).toBe(Date.parse("2026-10-30T09:00:00-04:00"));
    expect(localTime("2026-07-01T08:30:00", tz)).toBe(Date.parse("2026-07-01T08:30:00-04:00"));
    expect(localTime("2026-11-07T07:05:00+13:00", tz)).toBe(Date.parse("2026-11-06T18:05:00Z"));
    expect(localTime("next tuesday", tz)).toBeNull();
    // Either side of a daylight saving change: the evening before it, and the morning it springs forward.
    expect(localTime("2026-09-26T20:00", "Pacific/Auckland")).toBe(Date.parse("2026-09-26T20:00:00+12:00"));
    expect(localTime("2026-04-04T20:00", "Pacific/Auckland")).toBe(Date.parse("2026-04-04T20:00:00+13:00"));
    expect(localTime("2026-03-08T05:00", tz)).toBe(Date.parse("2026-03-08T05:00:00-04:00"));
  });

  test("upgrading drops the old screenshot inbox and keeps notes and sign-ins", () => {
    const path = join(mkdtempSync(join(tmpdir(), "sink-migrate-")), "sink.db");
    const old = new Database(path, { create: true, strict: true });
    // The database as it was just before the inbox went.
    const drop = migrations.findIndex((m) => m.includes("DROP TABLE IF EXISTS captures"));
    for (const m of migrations.slice(0, drop)) old.exec(m);
    old.exec(`PRAGMA user_version = ${drop}`);
    old.exec("INSERT INTO captures (id, created_at, updated_at, source, status) VALUES ('c1', 1, 1, 'web', 'done')");
    old.exec("INSERT INTO actions (id, capture_id, type, label, created_at) VALUES ('a1', 'c1', 'todo', 'x', 1)");
    old.exec("INSERT INTO tokens (id, name, token_hash, created_at) VALUES ('t1', 'phone', 'h', 1)");
    old.close();

    const db = openDb(path);
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    expect(tables).not.toContain("captures");
    expect(tables).not.toContain("actions");
    expect(tables).toContain("notes");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get()!.n).toBe(1);
    db.close();
  });

  test("upgrading makes whoever already signed in the owner, and their old tokens theirs", () => {
    const path = join(mkdtempSync(join(tmpdir(), "sink-migrate-")), "sink.db");
    const old = new Database(path, { create: true, strict: true });
    const before = migrations.findIndex((m) => m.includes("CREATE TABLE users"));
    for (const m of migrations.slice(0, before)) old.exec(m);
    old.exec(`PRAGMA user_version = ${before}`);
    old.exec("INSERT INTO tokens (id, name, token_hash, created_at) VALUES ('t1', 'old', 'h1', 1)");
    old.exec("INSERT INTO tokens (id, name, token_hash, created_at, subject) VALUES ('t2', 'phone', 'h2', 2, 'me')");
    old.close();

    const db = openDb(path);
    expect(db.query("SELECT subject, dir FROM users").all()).toEqual([{ subject: "me", dir: "" }]);
    expect(db.query("SELECT DISTINCT subject FROM tokens").all()).toEqual([{ subject: "me" }]);
    db.close();
  });

  test("fts query is sanitized", () => {
    expect(toFtsQuery(`wifi "pass" OR -x*`)).toBe(`"wifi"* "pass"* "OR"* "x"*`);
    expect(toFtsQuery("   ")).toBeNull();
  });
});

describe("accounts", () => {
  const send = (token: string, method: string, path: string, body?: unknown) =>
    setup.app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const titles = async (token: string) => ((await (await get(token, "/api/notes")).json()) as any).notes.map((n: any) => n.title);

  test("the first account keeps the vault; the next gets its own", async () => {
    const owner = await login();
    const other = setup.auth.issueToken("test", "someone-else");
    expect((await send(owner, "POST", "/api/notes", { title: "Mine" })).status).toBe(201);
    expect((await send(other, "POST", "/api/notes", { title: "Theirs" })).status).toBe(201);
    expect(await titles(owner)).toEqual(["Mine"]);
    expect(await titles(other)).toEqual(["Theirs"]);
    expect(existsSync(join(setup.vaultDir, "Mine.md"))).toBe(true);
    expect(existsSync(join(setup.vaultDir, "Theirs.md"))).toBe(false);
    expect((await get(other, "/api/notes/read?path=Mine.md")).status).toBe(404);
    expect(setup.users.isOwner("abc123")).toBe(true);
    expect(setup.users.isOwner("someone-else")).toBe(false);
    // Reopened (a restart), each account still finds its own notes.
    const again = new Users(setup.db, { db: setup.db, vault: setup.vault }, { dir: setup.usersDir });
    expect(again.for("someone-else").vault.list().notes.map((n) => n.title)).toEqual(["Theirs"]);
  });

  test("prefs follow the account, are checked, and need a full token", async () => {
    const owner = await login();
    const other = setup.auth.issueToken("test", "someone-else");
    const mcp = setup.auth.issueToken("assistant", "abc123", "mcp");
    expect(await (await get(owner, "/api/prefs")).json()).toEqual({});
    const set = await send(owner, "PATCH", "/api/prefs", { layout: "tabs" });
    expect(await set.json()).toEqual({ layout: "tabs" });
    await send(owner, "PATCH", "/api/prefs", { layoutChosen: true });
    expect(await (await get(owner, "/api/prefs")).json()).toEqual({ layout: "tabs", layoutChosen: true });
    expect(await (await get(other, "/api/prefs")).json()).toEqual({});
    expect((await send(owner, "PATCH", "/api/prefs", { layout: "fancy" })).status).toBe(400);
    expect((await send(owner, "PATCH", "/api/prefs", { colour: "red" })).status).toBe(400);
    expect((await get(mcp, "/api/prefs")).status).toBe(403);
  });

  test("tokens are listed and revoked per account", async () => {
    const owner = await login();
    const other = setup.auth.issueToken("Phone", "someone-else");
    const listed = ((await (await get(other, "/api/auth/tokens")).json()) as any).tokens;
    expect(listed.map((t: any) => t.name)).toEqual(["Phone"]);
    const ownerTokenId = setup.auth.check(owner)!.id;
    await send(other, "DELETE", `/api/auth/tokens/${ownerTokenId}`);
    expect(setup.auth.check(owner)).not.toBeNull();
  });

  test("the owner lets people in from Settings, and taking them off signs them out", async () => {
    setup = makeSetup(["sam@example.com"]);
    const owner = await login();
    const me = (await (await get(owner, "/api/auth/me")).json()) as any;
    expect(me.admin).toBe(true);
    expect(typeof me.subject).toBe("string");
    // Someone not on the list can't sign in yet.
    setup.authentik.state.user = { sub: "kim1", email: "kim@example.com", email_verified: true };
    expect((await signIn()).callback.status).toBe(403);

    expect((await send(owner, "POST", "/api/admin/users/allowed", { entry: "has space" })).status).toBe(400);
    expect((await send(owner, "POST", "/api/admin/users/allowed", { entry: "kim@example.com" })).status).toBe(201);
    const { callback } = await signIn();
    expect(callback.status).toBe(302);
    const kim = callback.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
    expect(((await (await get(kim, "/api/auth/me")).json()) as any).admin).toBe(false);
    expect((await get(kim, "/api/admin/users")).status).toBe(403);
    expect((await send(kim, "POST", "/api/admin/users/allowed", { entry: "x@example.com" })).status).toBe(403);

    const list = (await (await get(owner, "/api/admin/users")).json()) as any;
    expect(list.allowed).toEqual(["kim@example.com"]);
    expect(list.configured.users).toEqual(["sam@example.com"]);
    expect(list.accounts.map((a: any) => [a.email, a.owner])).toEqual([[null, true], ["kim@example.com", false]]);

    await send(owner, "DELETE", "/api/admin/users/allowed?entry=kim%40example.com");
    expect((await get(kim, "/api/notes")).status).toBe(401);
    expect((await get(owner, "/api/notes")).status).toBe(200);
    expect((await signIn()).callback.status).toBe(403);
  });

  test("public pages show only published notes, each account under its own name", async () => {
    const owner = await login();
    const other = setup.auth.issueToken("test", "someone-else");
    await get(owner, "/api/notes");
    await send(owner, "POST", "/api/notes", { title: "Hello", content: "# Hello\n\n![[pic.png]] and [[Secret]]" });
    await send(owner, "POST", "/api/notes", { title: "Secret", content: "# Secret\n\nnot for you" });
    const form = new FormData();
    form.append("file", new File([png], "pic.png", { type: "image/png" }));
    await setup.app.request("/api/notes/attachments", { method: "POST", headers: { authorization: `Bearer ${owner}` }, body: form });

    expect((await setup.app.request("/api/public/pages/josh")).status).toBe(404);
    expect((await send(owner, "PUT", "/api/publish", { handle: "Not OK!" })).status).toBe(400);
    expect((await send(owner, "PUT", "/api/publish", { handle: "Josh" })).status).toBe(200);
    expect((await send(other, "PUT", "/api/publish", { handle: "josh" })).status).toBe(409);
    expect((await send(other, "PUT", "/api/publish", { handle: "owner" })).status).toBe(409);
    expect(((await (await setup.app.request("/api/public/pages/owner")).json()) as any).handle).toBe("josh");

    // Nothing published yet: an empty page, and no way to read a note by guessing its path.
    expect(((await (await setup.app.request("/api/public/pages/josh")).json()) as any).notes).toEqual([]);
    expect((await setup.app.request("/api/public/pages/josh/note?path=Secret.md")).status).toBe(404);

    const meta = (await (await send(owner, "PATCH", "/api/notes/meta?path=Hello.md", { publish: true })).json()) as any;
    expect(meta.publish).toBe(true);
    expect(readFileSync(join(setup.vaultDir, "Hello.md"), "utf8")).toStartWith("---\npublish: true\n---\n");
    const page = (await (await setup.app.request("/api/public/pages/josh")).json()) as any;
    expect(page.notes.map((n: any) => n.title)).toEqual(["Hello"]);
    const note = (await (await setup.app.request("/api/public/pages/josh/note?path=Hello.md")).json()) as any;
    expect(note.content).not.toContain("publish");
    expect(note.content).toContain("[[Secret]]");
    expect((await setup.app.request("/api/public/pages/josh/note?path=Secret.md")).status).toBe(404);
    expect((await setup.app.request("/api/public/pages/josh/attachment?path=Hello.md&name=pic.png")).status).toBe(200);
    expect((await setup.app.request("/api/public/pages/josh/attachment?path=Secret.md&name=pic.png")).status).toBe(404);

    // Search engines: never the list itself, and a note only once it's marked searchable.
    expect(await robotsFor(setup.users, "/public/josh")).toBe("noindex, follow");
    expect(await robotsFor(setup.users, "/public/josh/Hello")).toBe("noindex, nofollow");
    await send(owner, "PATCH", "/api/notes/meta?path=Hello.md", { searchable: true });
    expect(await robotsFor(setup.users, "/public/josh/Hello")).toBeNull();
    expect(await robotsFor(setup.users, "/public/josh/Secret")).toBe("noindex, nofollow");
    expect(await robotsFor(setup.users, "/public/nobody/Hello")).toBe("noindex, nofollow");
    expect(await robotsFor(setup.users, "/public/josh/%E0%A4%A")).toBe("noindex, nofollow");

    // Another account's page is its own.
    await send(other, "PUT", "/api/publish", { handle: "kim" });
    expect(((await (await setup.app.request("/api/public/pages/kim")).json()) as any).notes).toEqual([]);
    expect((await setup.app.request("/api/public/pages/kim/note?path=Hello.md")).status).toBe(404);

    // Unpublishing takes it off.
    await send(owner, "PATCH", "/api/notes/meta?path=Hello.md", { publish: false });
    expect((await setup.app.request("/api/public/pages/josh/note?path=Hello.md")).status).toBe(404);
  });

  test("share links find the right account's note", async () => {
    await get(await login(), "/api/notes");
    const other = setup.auth.issueToken("test", "someone-else");
    await send(other, "POST", "/api/notes", { title: "Shared", content: "hello from them" });
    const share = (await (await send(other, "POST", "/api/notes/share", { path: "Shared.md" })).json()) as any;
    const page = (await (await setup.app.request(`/api/public/share/${share.id}`)).json()) as any;
    expect(page.content).toContain("hello from them");

    // A visitor's edit goes to that account's vault, not the owner's.
    await send(other, "POST", "/api/notes/share", { path: "Shared.md", editable: true });
    const { hash } = (await (await setup.app.request(`/api/public/share/${share.id}`)).json()) as any;
    const put = await setup.app.request(`/api/public/share/${share.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "edited by a visitor", base_hash: hash, name: "Visitor" }),
    });
    expect(put.status).toBe(200);
    expect(((await (await get(other, "/api/notes/file?path=Shared.md")).json()) as any).content).toContain("edited by a visitor");
    expect(existsSync(join(setup.vaultDir, "Shared.md"))).toBe(false);
    expect(((await (await get(other, "/api/notes/share?path=Shared.md")).json()) as any).edited_by).toBe("Visitor");
  });
});

describe("obsidian sync support", () => {
  const send = (token: string, method: string, path: string, body?: unknown) =>
    setup.app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const putFile = (token: string, path: string, bytes: Uint8Array | string, baseHash?: string) =>
    setup.app.request(`/api/notes/attachment?path=${encodeURIComponent(path)}${baseHash ? `&base_hash=${baseHash}` : ""}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: bytes,
    });
  const listed = async (token: string) => ((await (await get(token, "/api/notes/attachments")).json()) as any).items;

  test("obsidian sign-in hands back to the plugin and needs the PKCE verifier", async () => {
    expect((await setup.app.request("/api/auth/oidc/start?client=obsidian")).status).toBe(400);

    const verifier = "o".repeat(64);
    const { callback } = await signIn(`client=obsidian&challenge=${s256(verifier)}`);
    const location = new URL(callback.headers.get("location")!);
    expect(location.protocol).toBe("obsidian:");
    expect(location.host).toBe("sink-auth");
    expect(callback.headers.get("set-cookie")).toBeNull();
    const code = location.searchParams.get("code")!;

    const exchange = (v: string) =>
      setup.app.request("/api/auth/oidc/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, verifier: v }),
      });
    expect((await exchange("w".repeat(64))).status).toBe(400);
    expect((await exchange(verifier)).status).toBe(400);

    const again = await signIn(`client=obsidian&challenge=${s256(verifier)}`);
    const code2 = new URL(again.callback.headers.get("location")!).searchParams.get("code")!;
    const res = await setup.app.request("/api/auth/oidc/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code2, verifier }),
    });
    const { token } = (await res.json()) as { token: string };
    const [row] = setup.auth.listTokens("abc123") as { name: string; scope: string }[];
    expect([row!.name, row!.scope]).toEqual(["Obsidian", "full"]);
    // A full token: the things an assistant's can't do.
    expect((await send(token, "DELETE", "/api/notes/trash?all=true")).status).toBe(200);
  });

  test("the change stream can be read by Obsidian with a bearer header, and by no other origin", async () => {
    const ok = await setup.app.request("/api/events", {
      method: "OPTIONS",
      headers: { origin: "app://obsidian.md", "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
    });
    expect(ok.headers.get("access-control-allow-origin")).toBe("app://obsidian.md");
    expect(ok.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
    const evil = await setup.app.request("/api/events", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    // Other routes stay same-origin only.
    const other = await setup.app.request("/api/notes", { method: "OPTIONS", headers: { origin: "app://obsidian.md", "access-control-request-method": "GET" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a brief note list is just what a sync client compares", async () => {
    const token = await login();
    const made = (await (await send(token, "POST", "/api/notes", { title: "A", content: "# A\nbody" })).json()) as any;
    const brief = (await (await get(token, "/api/notes?brief=true")).json()) as any;
    expect(brief).toEqual({ notes: [{ path: "A.md", mtime: made.mtime, size: made.size, hash: sha256("# A\nbody") }] });
  });

  test("attachments are listed with a hash, and only the ones that are files you'd sync", async () => {
    const token = await login();
    writeFileSync(join(setup.vaultDir, "Note.md"), "# n");
    mkdirSync(join(setup.vaultDir, "pics/deep"), { recursive: true });
    mkdirSync(join(setup.vaultDir, ".obsidian"));
    writeFileSync(join(setup.vaultDir, "pics/deep/a.png"), png);
    writeFileSync(join(setup.vaultDir, "doc.pdf"), "pdf");
    writeFileSync(join(setup.vaultDir, ".obsidian/app.json"), "{}");
    writeFileSync(join(setup.vaultDir, "bad:name.png"), "x");

    const items = await listed(token);
    expect(items.map((i: any) => i.path).sort()).toEqual(["doc.pdf", "pics/deep/a.png"]);
    const a = items.find((i: any) => i.path === "pics/deep/a.png");
    expect(a).toMatchObject({ size: png.length, hash: sha256(png) });
    expect(typeof a.mtime).toBe("number");

    // An edit made outside Sink shows as a new hash (utimes: the cache goes by size and mtime).
    writeFileSync(join(setup.vaultDir, "doc.pdf"), "pdf, edited");
    utimesSync(join(setup.vaultDir, "doc.pdf"), new Date(), new Date(Date.now() + 5000));
    expect((await listed(token)).find((i: any) => i.path === "doc.pdf").hash).toBe(sha256("pdf, edited"));
    // The other account doesn't see them.
    expect(await listed(setup.auth.issueToken("test", "someone-else"))).toEqual([]);
  });

  test("a file can be saved to a path with a base hash, like a note", async () => {
    const token = await login();
    const created = await putFile(token, "pics/new.png", png);
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ path: "pics/new.png", size: png.length, hash: sha256(png) });
    expect(readFileSync(join(setup.vaultDir, "pics/new.png"))).toEqual(Buffer.from(png));

    // Creating needs the path to be free; the answer says what's there.
    expect((await putFile(token, "pics/new.png", "other")).status).toBe(409);

    const next = new Uint8Array([...png, 0]);
    const updated = await putFile(token, "pics/new.png", next, sha256(png));
    expect(await updated.json()).toMatchObject({ hash: sha256(next) });
    expect(readFileSync(join(setup.vaultDir, "pics/new.png"))).toEqual(Buffer.from(next));

    const stale = await putFile(token, "pics/new.png", "mine", sha256(png));
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as any).current).toMatchObject({ path: "pics/new.png", hash: sha256(next), size: next.length });
    expect(readFileSync(join(setup.vaultDir, "pics/new.png"))).toEqual(Buffer.from(next));

    // Gone meanwhile: the base hash can't match a file that isn't there.
    rmSync(join(setup.vaultDir, "pics/new.png"));
    expect((await putFile(token, "pics/new.png", "mine", sha256(next))).status).toBe(409);
    // No temp files left behind.
    expect(readdirSync(join(setup.vaultDir, "pics"))).toEqual([]);
  });

  test("saving a file refuses notes, hidden places and odd paths, and an assistant's token", async () => {
    const token = await login();
    for (const path of ["x.md", "../out.png", ".obsidian/a.png", "a/.b/c.png", "a:b.png"]) {
      expect((await putFile(token, path, "x")).status).toBe(400);
    }
    expect(readdirSync(setup.vaultDir)).toEqual([]);
    const mcp = setup.auth.issueToken("assistant", "abc123", "mcp");
    expect((await putFile(mcp, "a.png", "x")).status).toBe(403);
    expect((await get(mcp, "/api/notes/attachments")).status).toBe(200);
    expect((await get(mcp, "/api/notes?brief=true")).status).toBe(200);
  });

  test("a file bigger than the upload limit is refused", async () => {
    const token = await login();
    const app = createApp({
      db: setup.db,
      vault: setup.vault,
      users: setup.users,
      auth: setup.auth,
      oidc: new Oidc({ issuer: ISSUER, clientId: "c", clientSecret: "", allowedUsers: [], allowedGroups: [], allowAnyone: true }),
      config: { secureCookies: false, maxUploadBytes: 4, webDir: undefined, publicUrls: [PUBLIC] },
    });
    const res = await app.request("/api/notes/attachment?path=big.bin", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: "12345" });
    expect(res.status).toBe(413);
    expect(existsSync(join(setup.vaultDir, "big.bin"))).toBe(false);
  });

  test("a synced file can be found by name, moved and trashed", async () => {
    const token = await login();
    await putFile(token, "pics/cat.png", png);
    expect((await get(token, "/api/notes/attachment?name=cat.png")).status).toBe(200);

    expect((await send(token, "POST", "/api/notes/move", { from: "pics/cat.png", to: "photos/kitten.png" })).status).toBe(200);
    expect(readFileSync(join(setup.vaultDir, "photos/kitten.png"))).toEqual(Buffer.from(png));
    expect((await get(token, "/api/notes/attachment?name=cat.png")).status).toBe(404);
    expect((await get(token, "/api/notes/attachment?name=kitten.png")).status).toBe(200);
    expect((await listed(token)).map((i: any) => i.path)).toEqual(["photos/kitten.png"]);

    expect((await send(token, "DELETE", "/api/notes/file?path=photos/kitten.png")).status).toBe(200);
    expect(existsSync(join(setup.vaultDir, "photos/kitten.png"))).toBe(false);
    expect(readFileSync(join(setup.vaultDir, ".trash/photos/kitten.png"))).toEqual(Buffer.from(png));
    expect((await get(token, "/api/notes/attachment?name=kitten.png")).status).toBe(404);
    expect(await listed(token)).toEqual([]);
  });
});

describe("calendar feed", () => {
  const feedUrl = (token: string) => `/api/calendar/${token}.ics`;
  const row = (over: Partial<Parameters<typeof icsFeed>[0][number]> = {}) => ({
    path: "Plan.md",
    raw: "- [ ] Pay rates 📅 2026-11-02",
    text: "Pay rates",
    due: "2026-11-02",
    remind_at: Date.parse("2026-11-02T09:00:00+13:00"),
    note_title: "Plan",
    mtime: Date.parse("2026-10-30T01:02:03Z"),
    ...over,
  });
  const unfold = (ics: string) => ics.replace(/\r\n /g, "");

  test("open dated todos become events in the token owner's vault, nothing else", async () => {
    setup.users.for("abc123");
    await setup.vault.write(
      "Plan.md",
      [
        "# Plan",
        "- [ ] Pay rates 📅 2026-11-02",
        "- [ ] Call mum 📅 2026-11-03 (@2026-11-03 18:30)",
        "- [ ] Someday",
        "- [x] Book flights 📅 2026-10-20 ✅ 2026-10-20",
        "",
      ].join("\n"),
      null,
    );
    await setup.users.for("someone-else").vault.write("Theirs.md", "- [ ] Secret 📅 2026-11-04\n", null);
    const token = setup.auth.issueCalendarToken("abc123");
    const res = await setup.app.request(feedUrl(token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/calendar");
    const ics = await res.text();
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261102\r\n");
    expect(ics).toContain("SUMMARY:Pay rates\r\n");
    expect(ics).toContain("DTSTART:20261103T183000Z\r\n");
    expect(ics).toContain("BEGIN:VALARM");
    expect(ics.match(/BEGIN:VALARM/g)).toHaveLength(1);
    expect(ics).not.toContain("Someday");
    expect(ics).not.toContain("Book flights");
    expect(ics).not.toContain("Secret");
    // The same todos give the same ids on the next fetch, so calendar apps update rather than duplicate.
    const uids = (text: string) => text.match(/^UID:.*$/gm);
    expect(uids(await (await setup.app.request(feedUrl(token))).text())).toEqual(uids(ics)!);
    const theirs = setup.auth.issueCalendarToken("someone-else");
    expect(await (await setup.app.request(feedUrl(theirs))).text()).toContain("SUMMARY:Secret");
  });

  test("an event keeps its id when the todo moves to another date or line", () => {
    const uid = (r: ReturnType<typeof row>) => /^UID:(.*)$/m.exec(icsFeed([r], "UTC"))![1];
    expect(uid(row({ due: "2026-12-01", raw: "- [ ] Pay rates 📅 2026-12-01" }))).toBe(uid(row()));
    expect(uid(row({ text: "Pay water rates" }))).not.toBe(uid(row()));
    const twice = unfold(icsFeed([row(), row()], "UTC")).match(/^UID:.*$/gm)!;
    expect(new Set(twice).size).toBe(2);
  });

  test("timed todos use the configured zone; all-day ones have no time", () => {
    const ics = icsFeed([row({ raw: "- [ ] Call 📅 2026-11-02 (@2026-11-02 18:30)", remind_at: Date.parse("2026-11-02T18:30:00+13:00") })], "Pacific/Auckland");
    expect(ics).toContain("X-WR-TIMEZONE:Pacific/Auckland");
    expect(ics).toContain("DTSTART;TZID=Pacific/Auckland:20261102T183000\r\n");
    expect(ics).toContain("TRIGGER:PT0S");
    const allDay = icsFeed([row()], "Pacific/Auckland");
    expect(allDay).toContain("DTSTART;VALUE=DATE:20261102\r\n");
    expect(allDay).not.toContain("VALARM");
  });

  test("text is escaped and long lines are folded without splitting characters", () => {
    const text = "Buy milk, eggs; bread \\ butter\nsecond line " + "é🥛".repeat(60);
    const ics = icsFeed([row({ text })], "UTC");
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    const summary = /^SUMMARY:(.*)$/m.exec(unfold(ics))![1]!;
    expect(summary.startsWith("Buy milk\\, eggs\\; bread \\\\ butter\\nsecond line é🥛")).toBe(true);
    expect(summary).not.toContain("\ufffd");
  });

  test("recurring todos get an RRULE when it says the same thing", () => {
    const rule = (every: string, due = "2026-11-02") => /^RRULE:(.*)$/m.exec(icsFeed([row({ raw: `- [ ] Bins 🔁 ${every} 📅 ${due}`, due })], "UTC"))?.[1] ?? null;
    expect(rule("every week")).toBe("FREQ=WEEKLY");
    expect(rule("every 3 days")).toBe("FREQ=DAILY;INTERVAL=3");
    expect(rule("every weekday")).toBe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
    expect(rule("every Monday, Thursday")).toBe("FREQ=WEEKLY;BYDAY=MO,TH");
    expect(rule("every week on Friday")).toBe("FREQ=WEEKLY;BYDAY=FR");
    expect(rule("every month")).toBe("FREQ=MONTHLY");
    expect(rule("every month", "2026-01-31")).toBeNull();
    expect(rule("every week when done")).toBeNull();
    expect(rule("every fortnight")).toBeNull();
  });

  test("the token only opens the feed", async () => {
    const owner = await login();
    const created = await setup.app.request("/api/auth/calendar", { method: "POST", headers: { authorization: `Bearer ${owner}` } });
    expect(created.status).toBe(201);
    const token = ((await created.json()) as any).token;
    expect((await setup.app.request(feedUrl(token))).status).toBe(200);
    for (const path of ["/api/notes", "/api/todos", "/api/auth/tokens", "/api/auth/me", "/api/events"]) {
      expect((await get(token, path)).status).toBe(401);
      expect((await setup.app.request(path, { headers: { cookie: `sink_session=${token}` } })).status).toBe(401);
    }
    expect((await setup.app.request("/api/auth/calendar", { method: "POST", headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await setup.app.request("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect(setup.auth.check(token)).toBeNull();
    expect(setup.auth.verify(token)).toBeNull();
  });

  test("only full sign-ins make a feed link, and other tokens don't open the feed", async () => {
    const mcp = setup.auth.issueToken("assistant", "abc123", "mcp");
    expect((await setup.app.request("/api/auth/calendar", { method: "POST", headers: { authorization: `Bearer ${mcp}` } })).status).toBe(403);
    expect((await setup.app.request("/api/auth/calendar", { method: "POST" })).status).toBe(401);
    for (const other of [mcp, await login(), "sink_nope"]) expect((await setup.app.request(feedUrl(other))).status).toBe(404);
  });

  test("a new link replaces the old one, and a revoked one stops working", async () => {
    const owner = await login();
    const first = setup.auth.issueCalendarToken("abc123");
    const second = setup.auth.issueCalendarToken("abc123");
    expect((await setup.app.request(feedUrl(first))).status).toBe(404);
    expect((await setup.app.request(feedUrl(second))).status).toBe(200);
    const listed = ((await (await get(owner, "/api/auth/tokens")).json()) as any).tokens;
    const feed = listed.find((t: any) => t.scope === "calendar");
    expect(feed.last_used_at).not.toBeNull();
    const revoke = await setup.app.request(`/api/auth/tokens/${feed.id}`, { method: "DELETE", headers: { authorization: `Bearer ${owner}` } });
    expect(revoke.status).toBe(200);
    expect((await setup.app.request(feedUrl(second))).status).toBe(404);
  });
});

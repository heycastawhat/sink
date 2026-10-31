import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations, openDb } from "./db";
import { Auth, s256 } from "./auth";
import { Oidc } from "./oidc";
import { createApp } from "./app";
import { Backups } from "./backup";
import { pageText } from "./html";
import { readdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync, symlinkSync } from "node:fs";
import { Vault, parseNote, readFrontmatter, inlineTags, cleanPath, fileNameFor, toFtsQuery, firstImage } from "./notes";
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
  const app = createApp({
    db,
    vault,
    auth,
    oidc,
    config: { secureCookies: false, maxUploadBytes: 5 * 1024 * 1024, webDir: undefined, publicUrls: [PUBLIC] },
  });
  return { db, app, authentik, auth, vault, vaultDir };
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
    expect(await (await setup.app.request("/api/auth/info")).json()).toEqual({ provider: "Pocket ID" });
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

  test("revoked token stops working", async () => {
    const token = await login();
    await setup.app.request("/api/auth/logout", { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect((await get(token, "/api/notes")).status).toBe(401);
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

    const names = setup.auth.listTokens().map((t: any) => t.name);
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

  test("backlinks: wikilinks by name or path, aliases, headings, markdown links", async () => {
    const token = await login();
    const make = (folder: string, title: string, content: string) => send(token, "POST", "/api/notes", { folder, title, content });
    await make("Garden", "Soil", "# Soil\n\nLoam.\n");
    await make("", "Plan", "# Plan\n\nSee [[Soil]] first.\nUnrelated line.\nAlso [[soil#pH|the dirt]].\n");
    await make("Log", "Monday", "# Monday\n\nDug beds, per [[Garden/Soil]].\n");
    await make("", "Links", "# Links\n\n[soil notes](Garden/Soil.md)\n");
    await make("", "Other", "# Other\n\n[[Soil mix]] and [[Soils]] are different notes. https://x.y/Soil.md)\n");
    const res = await get(token, `/api/notes/backlinks?path=${encodeURIComponent("Garden/Soil.md")}`);
    const items = ((await res.json()) as any).items as { path: string; lines: string[] }[];
    expect(items.map((i) => i.path).sort()).toEqual(["Links.md", "Log/Monday.md", "Plan.md"]);
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
    expect((((await after.json()) as any).items as { path: string }[]).map((i) => i.path)).toEqual(["Links.md"]);
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

  test("moving or renaming a note updates links to it", async () => {
    const token = await login();
    const make = (folder: string, title: string, content: string) => send(token, "POST", "/api/notes", { folder, title, content });
    await make("Garden", "Soil", "# Soil\n");
    await make("", "Plan", "# Plan\n\n[[Soil]], [[soil#pH|the dirt]], ![[Garden/Soil]], [notes](Garden/Soil.md#top), [[Soils]], [[Other]]\n");
    await send(token, "POST", "/api/notes/move", { from: "Garden/Soil.md", to: "Beds/Loam.md" });
    const plan = ((await (await get(token, q("Plan.md"))).json()) as any).content;
    expect(plan).toBe("# Plan\n\n[[Loam]], [[Loam#pH|the dirt]], ![[Beds/Loam]], [notes](Beds/Loam.md#top), [[Soils]], [[Other]]\n");

    // A bare name another note also has is left alone: it may mean that one.
    await make("", "Loam", "# Loam (the other one)\n");
    await make("", "Mix", "# Mix\n\n[[Loam]] and [[Beds/Loam]]\n");
    await send(token, "POST", "/api/notes/move", { from: "Beds/Loam.md", to: "Beds/Clay.md" });
    expect(((await (await get(token, q("Mix.md"))).json()) as any).content).toBe("# Mix\n\n[[Loam]] and [[Beds/Clay]]\n");

    // A whole folder moving updates path links into it.
    await send(token, "POST", "/api/notes/move", { from: "Beds", to: "Garden/Beds" });
    expect(((await (await get(token, q("Mix.md"))).json()) as any).content).toBe("# Mix\n\n[[Loam]] and [[Garden/Beds/Clay]]\n");
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
    expect(nextOccurrence("- [ ] One-off 📅 2026-10-30", "2026-10-30")).toBeNull();
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

  test("fts query is sanitized", () => {
    expect(toFtsQuery(`wifi "pass" OR -x*`)).toBe(`"wifi"* "pass"* "OR"* "x"*`);
    expect(toFtsQuery("   ")).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { Auth } from "./auth";
import { Oidc } from "./oidc";
import { Vault } from "./notes";
import { Users } from "./users";
import { createApp } from "./app";

const PUBLIC = "https://sink.test";
const b64 = (b: Uint8Array | ArrayBuffer) => Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : b).toString("base64url");
const sha = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(b)));
const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));

/** Just enough CBOR (maps, ints, byte and text strings) for an attestation object and a COSE key. */
function cbor(v: unknown): Uint8Array {
  const head = (major: number, n: number) =>
    n < 24 ? [(major << 5) | n] : n < 256 ? [(major << 5) | 24, n] : [(major << 5) | 25, n >> 8, n & 255];
  if (typeof v === "number") return Uint8Array.from(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === "string") return cat(Uint8Array.from(head(3, Buffer.byteLength(v))), new TextEncoder().encode(v));
  if (v instanceof Uint8Array) return cat(Uint8Array.from(head(2, v.length)), v);
  const entries = v instanceof Map ? [...v] : Object.entries(v as object);
  return cat(Uint8Array.from(head(5, entries.length)), ...entries.flatMap(([k, val]) => [cbor(k), cbor(val)]));
}

/** ECDSA's raw r|s as the DER that WebAuthn signatures use. */
function der(sig: Uint8Array) {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.slice(i);
    return v[0]! & 0x80 ? cat(Uint8Array.of(0x02, v.length + 1, 0), v) : cat(Uint8Array.of(0x02, v.length), v);
  };
  const body = cat(int(sig.slice(0, 32)), int(sig.slice(32)));
  return cat(Uint8Array.of(0x30, body.length), body);
}

/** A software passkey: what a phone or password manager does when a page calls navigator.credentials. */
async function authenticator() {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const id = crypto.getRandomValues(new Uint8Array(16));
  let count = 0;
  const rpHash = (rpId: string) => sha(new TextEncoder().encode(rpId));
  const clientData = (type: string, challenge: string, origin: string) => new TextEncoder().encode(JSON.stringify({ type, challenge, origin }));
  return {
    async create(options: any, origin = PUBLIC) {
      const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
      const authData = cat(await rpHash(options.rp.id), Uint8Array.of(0x45), new Uint8Array(4), new Uint8Array(16), Uint8Array.of(0, id.length), id, cose);
      return {
        id: b64(id),
        rawId: b64(id),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64(clientData("webauthn.create", options.challenge, origin)),
          attestationObject: b64(cbor({ fmt: "none", attStmt: {}, authData })),
          transports: ["internal"],
        },
      };
    },
    async get(options: any, origin = PUBLIC) {
      const data = clientData("webauthn.get", options.challenge, origin);
      const authData = cat(await rpHash(options.rpId), Uint8Array.of(0x05), Uint8Array.of(0, 0, 0, ++count));
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, cat(authData, await sha(data))));
      return {
        id: b64(id),
        rawId: b64(id),
        type: "public-key",
        clientExtensionResults: {},
        response: { clientDataJSON: b64(data), authenticatorData: b64(authData), signature: b64(der(sig)) },
      };
    },
  };
}

function setup(o: { allowedUsers?: string[]; allowAnyone?: boolean } = {}) {
  const db = openDb(":memory:");
  const vault = new Vault(db, mkdtempSync(join(tmpdir(), "sink-vault-")));
  const users = new Users(db, { db, vault }, { dir: mkdtempSync(join(tmpdir(), "sink-users-")) });
  const auth = new Auth(db);
  const oidc = new Oidc({ issuer: "https://auth.test/", clientId: "x", clientSecret: "", allowedUsers: o.allowedUsers ?? ["owner@example.com"], allowedGroups: [], allowAnyone: o.allowAnyone ?? false });
  const app = createApp({ db, vault, users, auth, oidc, config: { secureCookies: false, maxUploadBytes: 1024 * 1024, webDir: undefined, publicUrls: [PUBLIC] } });
  const owner = auth.issueToken("Web", "owner-sub");
  const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(PUBLIC + path, {
      method,
      headers: { "content-type": "application/json", origin: PUBLIC, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const asOwner = (method: string, path: string, body?: unknown) => req(method, path, body, { authorization: `Bearer ${owner}` });
  return { app, auth, users, req, asOwner, db };
}

const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0]!;

/** An invited person with a passkey: their authenticator, session cookie and allowlist entry. */
async function invitePasskey(s: ReturnType<typeof setup>, name: string) {
  const invite = (await (await s.asOwner("POST", "/api/admin/invites", { name })).json()) as any;
  const token = new URL(invite.url).searchParams.get("invite")!;
  const key = await authenticator();
  const reg = (await (await s.req("POST", "/api/auth/passkey/register/options", { invite: token })).json()) as any;
  const made = await s.req("POST", "/api/auth/passkey/register", { flow: reg.flow, invite: token, response: await key.create(reg.options) });
  const people = (await (await s.asOwner("GET", "/api/admin/users")).json()) as any;
  return { key, session: cookieOf(made), entry: people.allowed.find((e: string) => e.startsWith("sub:passkey:")) as string };
}

const form = (data: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  body: new URLSearchParams(data).toString(),
});
const verifier = "v".repeat(43);
const pkce = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
const REDIRECT = "https://client.example/cb";

/** Registers an MCP client and runs the consent screen with `cookie`; the authorization code, or null if refused. */
async function oauthCode(s: ReturnType<typeof setup>, cookie: string) {
  const reg = await s.app.request(`${PUBLIC}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "App" }),
  });
  const client = ((await reg.json()) as any).client_id as string;
  const q = new URLSearchParams({ client_id: client, redirect_uri: REDIRECT, response_type: "code", code_challenge: pkce, code_challenge_method: "S256" });
  const page = await s.app.request(`${PUBLIC}/oauth/authorize?${q}`, { headers: { cookie } });
  const request = (await page.text()).match(/name="request" value="([^"]+)"/)?.[1];
  if (!request) return { client, code: null };
  const res = await s.app.request(`${PUBLIC}/oauth/authorize`, form({ request, decision: "allow" }, { cookie }));
  return { client, code: new URL(res.headers.get("location")!).searchParams.get("code") };
}
const swapCode = (s: ReturnType<typeof setup>, client: string, code: string) =>
  s.app.request(`${PUBLIC}/oauth/token`, form({ grant_type: "authorization_code", code, client_id: client, code_verifier: verifier }));

describe("passkeys", () => {
  test("an invite makes an account with a passkey, which signs in again later; removing them signs them out", async () => {
    const s = setup();
    await s.asOwner("GET", "/api/notes");
    expect((await s.req("POST", "/api/admin/invites", { name: "Kim" })).status).toBe(401);
    const invite = (await (await s.asOwner("POST", "/api/admin/invites", { name: "Kim" })).json()) as any;
    expect(invite.url).toStartWith(`${PUBLIC}/?invite=`);
    const token = new URL(invite.url).searchParams.get("invite")!;
    expect(await (await s.req("GET", `/api/auth/passkey/invite?token=${token}`)).json()).toEqual({ name: "Kim" });

    const kim = await authenticator();
    const reg = (await (await s.req("POST", "/api/auth/passkey/register/options", { invite: token })).json()) as any;
    // A passkey made for another site doesn't count.
    const wrong = await s.req("POST", "/api/auth/passkey/register", { flow: reg.flow, invite: token, response: await kim.create(reg.options, "https://evil.test") });
    expect(wrong.status).toBe(400);
    const reg2 = (await (await s.req("POST", "/api/auth/passkey/register/options", { invite: token })).json()) as any;
    const made = await s.req("POST", "/api/auth/passkey/register", { flow: reg2.flow, invite: token, response: await kim.create(reg2.options) });
    expect(made.status).toBe(200);
    expect(((await made.json()) as any).redirect).toBe(`${PUBLIC}/`);
    const session = cookieOf(made);

    // Their own empty notes, not the owner's; and the invite is used up.
    expect((await s.app.request(`${PUBLIC}/api/notes`, { headers: { cookie: session } })).status).toBe(200);
    expect(s.users.isOwner(s.auth.check(session.split("=")[1]!)!.subject)).toBe(false);
    expect((await s.req("GET", `/api/auth/passkey/invite?token=${token}`)).status).toBe(404);
    expect((await (await s.req("GET", "/api/auth/info")).json()) as any).toMatchObject({ passkeys: true });
    const people = (await (await s.asOwner("GET", "/api/admin/users")).json()) as any;
    expect(people.invites).toEqual([]);
    expect(people.accounts.find((a: any) => a.username === "Kim")).toBeTruthy();

    // Signing in again, on the web and from the Android app (which gets a hand-back code to swap for a token).
    const opts = (await (await s.req("POST", "/api/auth/passkey/login/options", {})).json()) as any;
    const login = await s.req("POST", "/api/auth/passkey/login", { flow: opts.flow, response: await kim.get(opts.options) });
    expect(login.status).toBe(200);
    // A challenge only works once.
    expect((await s.req("POST", "/api/auth/passkey/login", { flow: opts.flow, response: await kim.get(opts.options) })).status).toBe(400);
    const verifier = "v".repeat(43);
    const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
    const opts2 = (await (await s.req("POST", "/api/auth/passkey/login/options", {})).json()) as any;
    const android = (await (
      await s.req("POST", "/api/auth/passkey/login", { flow: opts2.flow, response: await kim.get(opts2.options), client: "android", challenge })
    ).json()) as any;
    const code = new URL(android.redirect).searchParams.get("code");
    const swapped = (await (await s.req("POST", "/api/auth/oidc/exchange", { code, verifier })).json()) as any;
    expect(s.auth.check(swapped.token)?.subject).toBe(s.auth.check(session.split("=")[1]!)!.subject);

    const entry = people.allowed[0];
    expect(entry).toStartWith("sub:passkey:");
    await s.asOwner("DELETE", `/api/admin/users/allowed?entry=${encodeURIComponent(entry)}`);
    expect((await s.app.request(`${PUBLIC}/api/notes`, { headers: { cookie: session } })).status).toBe(401);
    const opts3 = (await (await s.req("POST", "/api/auth/passkey/login/options", {})).json()) as any;
    expect((await s.req("POST", "/api/auth/passkey/login", { flow: opts3.flow, response: await kim.get(opts3.options) })).status).toBe(403);
  });

  test("two registrations racing on one invite make one account", async () => {
    const s = setup();
    await s.asOwner("GET", "/api/notes");
    const invite = (await (await s.asOwner("POST", "/api/admin/invites", { name: "Kim" })).json()) as any;
    const token = new URL(invite.url).searchParams.get("invite")!;
    const [a, b] = [await authenticator(), await authenticator()];
    const ra = (await (await s.req("POST", "/api/auth/passkey/register/options", { invite: token })).json()) as any;
    const rb = (await (await s.req("POST", "/api/auth/passkey/register/options", { invite: token })).json()) as any;
    const [one, two] = await Promise.all([
      s.req("POST", "/api/auth/passkey/register", { flow: ra.flow, invite: token, response: await a.create(ra.options) }),
      s.req("POST", "/api/auth/passkey/register", { flow: rb.flow, invite: token, response: await b.create(rb.options) }),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 400]);
    const people = (await (await s.asOwner("GET", "/api/admin/users")).json()) as any;
    expect(people.allowed.filter((e: string) => e.startsWith("sub:passkey:"))).toHaveLength(1);
  });

  test("invites can be cancelled, and only the owner makes them", async () => {
    const s = setup();
    await s.asOwner("GET", "/api/notes");
    const invite = (await (await s.asOwner("POST", "/api/admin/invites", { name: "Lee" })).json()) as any;
    const token = new URL(invite.url).searchParams.get("invite")!;
    await s.asOwner("DELETE", `/api/admin/invites/${invite.id}`);
    expect((await s.req("POST", "/api/auth/passkey/register/options", { invite: token })).status).toBe(404);
    const other = s.auth.issueToken("Web", "someone-else");
    expect((await s.req("POST", "/api/admin/invites", { name: "X" }, { authorization: `Bearer ${other}` })).status).toBe(403);
  });

  test("removing a passkey person keeps them out even when any provider account may sign in", async () => {
    const s = setup({ allowedUsers: [], allowAnyone: true });
    await s.asOwner("GET", "/api/notes");
    const { key, session, entry } = await invitePasskey(s, "Kim");
    await s.asOwner("DELETE", `/api/admin/users/allowed?entry=${encodeURIComponent(entry)}`);
    expect((await s.app.request(`${PUBLIC}/api/notes`, { headers: { cookie: session } })).status).toBe(401);
    const opts = (await (await s.req("POST", "/api/auth/passkey/login/options", {})).json()) as any;
    expect((await s.req("POST", "/api/auth/passkey/login", { flow: opts.flow, response: await key.get(opts.options) })).status).toBe(403);
  });

  test("removing a passkey person signs them out even if their invite name matches a user: entry", async () => {
    const s = setup({ allowedUsers: ["owner@example.com", "user:sam"] });
    await s.asOwner("GET", "/api/notes");
    const { session, entry } = await invitePasskey(s, "sam");
    await s.asOwner("DELETE", `/api/admin/users/allowed?entry=${encodeURIComponent(entry)}`);
    expect((await s.app.request(`${PUBLIC}/api/notes`, { headers: { cookie: session } })).status).toBe(401);
  });

  test("codes made before someone was removed don't sign them back in", async () => {
    const s = setup();
    await s.asOwner("GET", "/api/notes");
    const { session, entry } = await invitePasskey(s, "Kim");
    const qr = (await (await s.app.request(`${PUBLIC}/api/auth/qr`, { method: "POST", headers: { cookie: session, origin: PUBLIC } })).json()) as any;
    const { client, code } = await oauthCode(s, session);
    expect(code).toBeTruthy();
    await s.asOwner("DELETE", `/api/admin/users/allowed?entry=${encodeURIComponent(entry)}`);
    const login = new URL(qr.url).searchParams.get("login");
    expect((await s.req("POST", "/api/auth/qr/exchange", { code: login, device: "Phone" })).status).toBe(400);
    expect((await swapCode(s, client, code!)).status).toBe(400);
  });

  test("an assistant's token can't stand in for a browser session to grant itself access", async () => {
    const s = setup();
    await s.asOwner("GET", "/api/notes");
    const mcp = s.auth.issueToken("Claude (MCP)", "owner-sub", "mcp", 60 * 60_000);
    expect((await oauthCode(s, `sink_session=${mcp}`)).code).toBeNull();
  });

  test("an expired access token still revokes its grant", async () => {
    const s = setup();
    const owner = s.auth.issueToken("Web", "owner-sub");
    await s.asOwner("GET", "/api/notes");
    const { client, code } = await oauthCode(s, `sink_session=${owner}`);
    const tok = (await (await swapCode(s, client, code!)).json()) as any;
    s.db.query("UPDATE tokens SET expires_at = 1 WHERE scope = 'mcp'").run();
    await s.app.request(`${PUBLIC}/oauth/revoke`, form({ token: tok.access_token }));
    const again = await s.app.request(`${PUBLIC}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: client }));
    expect(again.status).toBe(400);
  });

  test("malformed escapes are a refusal, not a server error", async () => {
    const s = setup();
    const res = await s.app.request(`${PUBLIC}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: "x" }, { authorization: `Basic ${btoa("abc%zz:secret")}` }));
    expect(res.status).toBe(401);
    expect((await s.asOwner("GET", "/plugins/x/%zz")).status).toBe(404);
  });
});

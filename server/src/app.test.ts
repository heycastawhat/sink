import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { openDb } from "./db";
import { Auth, s256 } from "./auth";
import { Oidc } from "./oidc";
import { MediaStore } from "./media";
import { Worker, dueAt } from "./worker";
import { createApp } from "./app";
import { ProviderError, type Provider } from "./ai/provider";
import { parseExtraction, localIso, utcOffset, type ExtractInput } from "./ai/extract";
import { toFtsQuery } from "./routes/captures";
import { VectorIndex, fuse, type Embedder } from "./semantic";
import { Backups } from "./backup";
import { readdirSync } from "node:fs";
import { Database } from "bun:sqlite";

/** Embeds by concept so synonyms land together, the way a real model would. */
class FakeEmbedder implements Embedder {
  model = "fake-embedder";
  minLift = 0.3;
  band = 1;
  static concepts = [
    ["wifi", "internet", "network", "password", "router"],
    ["gig", "concert", "music", "tickets", "band"],
    ["receipt", "groceries", "total", "supermarket"],
  ];
  async embed(texts: string[]) {
    return texts.map((t) => {
      const words = t.toLowerCase().match(/[a-z]+/g) ?? [];
      const v = new Float32Array(FakeEmbedder.concepts.length + 1);
      FakeEmbedder.concepts.forEach((group, i) => (v[i] = words.filter((w) => group.includes(w)).length));
      v[v.length - 1] = 0.01;
      const norm = Math.hypot(...v);
      return v.map((x) => x / norm);
    });
  }
}

class FakeProvider implements Provider {
  enabled = true;
  calls: ExtractInput[] = [];
  fail: ProviderError | null = null;
  async extract(input: ExtractInput) {
    this.calls.push(input);
    if (this.fail) throw this.fail;
    return {
      model: "fake",
      extraction: parseExtraction(
        JSON.stringify({
          kind: "event",
          title: "Laneway gig",
          summary: "Concert at the Powerstation",
          tags: ["Music", "gig"],
          entities: { dates: ["2026-11-01T20:00:00+13:00"] },
          actions: [{ type: "calendar", label: "Add to calendar", payload: { title: "Gig" } }],
        }),
      ),
    };
  }
}

const png = await sharp({ create: { width: 64, height: 128, channels: 3, background: "#c8693a" } })
  .png()
  .toBuffer();

let setup: ReturnType<typeof makeSetup>;

const ISSUER = "https://auth.test/application/o/sink/";
const PUBLIC = "https://sink.test";

/** Stand-in for authentik: discovery + token endpoint, minting an id_token for `user`. */
function fakeAuthentik() {
  const state = { nonce: "", user: { sub: "abc123", preferred_username: "josh", email: "josh@example.com" }, tokenCalls: 0 };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: "https://auth.test/application/o/authorize/",
        token_endpoint: "https://auth.test/application/o/token/",
      });
    }
    if (url === "https://auth.test/application/o/token/") {
      state.tokenCalls++;
      const body = new URLSearchParams(String(init?.body));
      if (body.get("code") !== "good-code" || !body.get("code_verifier")) return new Response("bad", { status: 400 });
      const claims = { iss: ISSUER, aud: "sink-client", exp: Date.now() / 1000 + 300, nonce: state.nonce, ...state.user };
      const id_token = `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
      return Response.json({ id_token, access_token: "a" });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { state, fetchImpl };
}

function makeSetup(allowedUsers: string[] = []) {
  const db = openDb(":memory:");
  const media = new MediaStore(mkdtempSync(join(tmpdir(), "sink-test-")));
  const auth = new Auth(db);
  const authentik = fakeAuthentik();
  const oidc = new Oidc(
    { issuer: ISSUER, clientId: "sink-client", clientSecret: "secret", allowedUsers, allowedGroups: [] },
    authentik.fetchImpl,
  );
  const provider = new FakeProvider();
  const index = new VectorIndex(db, new FakeEmbedder());
  const worker = new Worker(db, media, provider, { pollMs: 1000, maxAttempts: 3 }, 512, index);
  const app = createApp({
    db,
    media,
    auth,
    oidc,
    index,
    provider,
    config: { secureCookies: false, maxUploadBytes: 5 * 1024 * 1024, webDir: undefined, publicUrls: [PUBLIC] },
  });
  return { db, app, provider, worker, authentik, auth };
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

async function upload(token: string, fields: Record<string, string> = {}, variant = 0) {
  const form = new FormData();
  const bytes = variant
    ? await sharp({ create: { width: 64, height: 128, channels: 3, background: { r: variant * 40, g: 10, b: 10 } } }).png().toBuffer()
    : png;
  form.set("image", new File([bytes], "s.png", { type: "image/png" }));
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return setup.app.request("/api/captures", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
}

const get = (token: string, path: string) =>
  setup.app.request(path, { headers: { authorization: `Bearer ${token}` } });

beforeEach(() => {
  setup = makeSetup();
});

describe("auth", () => {
  test("rejects unauthenticated api calls", async () => {
    expect((await setup.app.request("/api/captures")).status).toBe(401);
    expect((await setup.app.request("/api/media/x/thumb")).status).toBe(401);
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
    expect((await setup.app.request("/api/captures", { headers: { cookie: session } })).status).toBe(200);
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
    setup = makeSetup(["JOSH"]);
    expect((await signIn()).callback.status).toBe(302);
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
    expect((await get(token, "/api/captures")).status).toBe(200);
  });

  test("revoked token stops working", async () => {
    const token = await login();
    await setup.app.request("/api/auth/logout", { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect((await get(token, "/api/captures")).status).toBe(401);
  });
});

describe("captures", () => {
  test("upload, process, search, fetch media", async () => {
    const token = await login();
    const res = await upload(token, { note: "want tickets", ocr_text: "Powerstation Saturday 8pm" });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; status: string; width: number };
    expect(created.status).toBe("pending");
    expect(created.width).toBe(64);

    // AI processing, then the embedding for semantic search.
    expect(await setup.worker.tick()).toBe(2);
    expect(setup.provider.calls[0]!.note).toBe("want tickets");
    expect(setup.provider.calls[0]!.imageDataUrl).toStartWith("data:image/jpeg;base64,");

    const detail = (await (await get(token, `/api/captures/${created.id}`)).json()) as any;
    expect(detail.status).toBe("done");
    expect(detail.kind).toBe("event");
    expect(detail.tags).toEqual(["music", "gig"]);
    expect(detail.actions).toHaveLength(1);

    // Search hits AI title, OCR text and note.
    for (const q of ["laneway", "powerst", "tickets"]) {
      const list = (await (await get(token, `/api/captures?q=${q}`)).json()) as any;
      expect(list.items.map((i: any) => i.id)).toEqual([created.id]);
    }
    const none = (await (await get(token, "/api/captures?q=zzz")).json()) as any;
    expect(none.items).toHaveLength(0);

    const thumb = await get(token, `/api/media/${created.id}/thumb`);
    expect(thumb.headers.get("content-type")).toBe("image/webp");
  });

  test("client_id makes uploads idempotent", async () => {
    const token = await login();
    const a = (await (await upload(token, { client_id: "abc" })).json()) as any;
    const b = (await (await upload(token, { client_id: "abc" })).json()) as any;
    expect(a.id).toBe(b.id);
  });

  test("same image twice merges, keeping the note", async () => {
    const token = await login();
    const a = (await (await upload(token, { source: "auto" })).json()) as any;
    const b = (await (await upload(token, { note: "remember this", source: "share" })).json()) as any;
    expect(b.id).toBe(a.id);
    expect(b.note_text).toBe("remember this");
    const list = (await (await get(token, "/api/captures")).json()) as any;
    expect(list.items).toHaveLength(1);
  });

  test("assistant captures keep screen text, OCR and page URL", async () => {
    const token = await login();
    const res = await upload(token, {
      source: "assist",
      screen_text: "Laneway 2027 lineup",
      ocr_text: "LANEWAY",
      source_url: "https://lanewayfestival.com/auckland",
    });
    const c = (await res.json()) as any;
    expect(c.source).toBe("assist");
    expect(c.source_url).toBe("https://lanewayfestival.com/auckland");
    expect(c.ocr_text).toBe("Laneway 2027 lineup\n\n--- OCR ---\nLANEWAY");
    await setup.worker.tick();
    expect(setup.provider.calls[0]!.sourceUrl).toBe("https://lanewayfestival.com/auckland");
  });

  test("rejects non-images", async () => {
    const token = await login();
    const form = new FormData();
    form.set("image", new File(["not an image"], "x.png"));
    const res = await setup.app.request("/api/captures", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    expect(res.status).toBe(415);
  });

  test("retryable AI failure reschedules, permanent failure marks failed", async () => {
    const token = await login();
    const { id } = (await (await upload(token)).json()) as any;

    setup.provider.fail = new ProviderError("429", true);
    await setup.worker.tick();
    let detail = (await (await get(token, `/api/captures/${id}`)).json()) as any;
    expect(detail.status).toBe("pending");

    setup.db.query("UPDATE jobs SET run_after = 0").run();
    setup.provider.fail = new ProviderError("bad", false);
    await setup.worker.tick();
    detail = (await (await get(token, `/api/captures/${id}`)).json()) as any;
    expect(detail.status).toBe("failed");
  });

  test("paging, views and patch", async () => {
    const token = await login();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(((await (await upload(token, { captured_at: String(1000 + i) }, i)).json()) as any).id);

    const p1 = (await (await get(token, "/api/captures?limit=3")).json()) as any;
    expect(p1.items).toHaveLength(3);
    const p2 = (await (await get(token, `/api/captures?limit=3&cursor=${p1.next_cursor}`)).json()) as any;
    expect(p2.items).toHaveLength(2);
    expect(p2.next_cursor).toBeNull();
    expect([...p1.items, ...p2.items].map((i: any) => i.id)).toEqual([...ids].reverse());

    await setup.app.request(`/api/captures/${ids[0]}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ deleted: true }),
    });
    const all = (await (await get(token, "/api/captures")).json()) as any;
    expect(all.items).toHaveLength(4);
    const trash = (await (await get(token, "/api/captures?view=trash")).json()) as any;
    expect(trash.items.map((i: any) => i.id)).toEqual([ids[0]]);
  });
});

describe("collections", () => {
  const send = (token: string, method: string, path: string, body?: unknown) =>
    setup.app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  test("create, rename, file captures, filter, count, delete", async () => {
    const token = await login();
    const a = ((await (await upload(token, {}, 1)).json()) as any).id;
    const b = ((await (await upload(token, {}, 2)).json()) as any).id;

    const created = await send(token, "POST", "/api/collections", { name: " Trip " });
    expect(created.status).toBe(201);
    const trip = (await created.json()) as any;
    expect(trip).toMatchObject({ name: "Trip", count: 0, cover_url: null });
    expect((await send(token, "POST", "/api/collections", { name: "trip" })).status).toBe(409);
    expect((await send(token, "POST", "/api/collections", { name: "" })).status).toBe(400);
    const gifts = (await (await send(token, "POST", "/api/collections", { name: "Gifts" })).json()) as any;

    const patched = (await (await send(token, "PATCH", `/api/captures/${a}`, { collections: [trip.id, gifts.id] })).json()) as any;
    expect(patched.collections.sort()).toEqual([trip.id, gifts.id].sort());
    await send(token, "PATCH", `/api/captures/${b}`, { collections: [trip.id] });
    expect((await send(token, "PATCH", `/api/captures/${b}`, { collections: ["nope"] })).status).toBe(400);
    expect(((await (await get(token, `/api/captures/${b}`)).json()) as any).collections).toEqual([trip.id]);

    const inTrip = (await (await get(token, `/api/captures?collection=${trip.id}`)).json()) as any;
    expect(inTrip.items.map((i: any) => i.id).sort()).toEqual([a, b].sort());
    const inGifts = (await (await get(token, `/api/captures?collection=${gifts.id}`)).json()) as any;
    expect(inGifts.items.map((i: any) => i.id)).toEqual([a]);

    // Trashed captures drop out of counts.
    await send(token, "PATCH", `/api/captures/${b}`, { deleted: true });
    let list = ((await (await get(token, "/api/collections")).json()) as any).collections;
    expect(list.map((c: any) => [c.name, c.count])).toEqual([["Gifts", 1], ["Trip", 1]]);
    expect(list[1].cover_url).toBe(`/api/media/${a}/thumb`);

    expect((await send(token, "PATCH", `/api/collections/${trip.id}`, { name: "gifts" })).status).toBe(409);
    expect(((await (await send(token, "PATCH", `/api/collections/${trip.id}`, { name: "Japan" })).json()) as any).name).toBe("Japan");

    expect((await send(token, "DELETE", `/api/collections/${gifts.id}`)).status).toBe(200);
    expect((await send(token, "DELETE", `/api/collections/${gifts.id}`)).status).toBe(404);
    expect(((await (await get(token, `/api/captures/${a}`)).json()) as any).collections).toEqual([trip.id]);
    list = ((await (await get(token, "/api/collections")).json()) as any).collections;
    expect(list.map((c: any) => c.name)).toEqual(["Japan"]);
  });
});

describe("reminders", () => {
  test("future reminders are listed, accepted and snoozed; past ones are not", async () => {
    const token = await login();
    const { id } = (await (await upload(token)).json()) as any;
    const soon = new Date(Date.now() + 3600_000).toISOString();
    setup.provider.extract = async () => ({
      model: "fake",
      extraction: parseExtraction(
        JSON.stringify({
          kind: "event",
          title: "Tickets",
          actions: [
            { type: "reminder", label: "Tickets on sale", payload: { text: "Buy tickets", due: soon } },
            { type: "reminder", label: "Too late", payload: { text: "old", due: "2020-01-01T09:00:00+13:00" } },
            { type: "copy", label: "Copy", payload: { text: "x" } },
          ],
        }),
      ),
    });
    await setup.worker.tick();

    let list = (await (await get(token, "/api/reminders")).json()) as any;
    expect(list.reminders.map((r: any) => r.label)).toEqual(["Tickets on sale"]);
    expect(list.reminders[0].due_at).toBe(Date.parse(soon));
    expect(list.reminders[0].capture_id).toBe(id);

    const patch = (body: object) =>
      setup.app.request(`/api/actions/${list.reminders[0].id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const later = Date.now() + 7200_000;
    expect((await patch({ state: "accepted", due_at: later })).status).toBe(200);
    list = (await (await get(token, "/api/reminders")).json()) as any;
    expect(list.reminders[0].state).toBe("accepted");
    expect(list.reminders[0].due_at).toBe(later);

    await patch({ state: "done" });
    expect(((await (await get(token, "/api/reminders")).json()) as any).reminders).toHaveLength(0);
  });

  test("due times without a zone are the user's local time", () => {
    const tz = "Pacific/Auckland";
    expect(dueAt({ type: "reminder", payload: { due: "2026-10-30" } }, tz)).toBe(Date.parse("2026-10-30T09:00:00+13:00"));
    expect(dueAt({ type: "reminder", payload: { due: "2026-07-01T08:30:00" } }, tz)).toBe(Date.parse("2026-07-01T08:30:00+12:00"));
    expect(dueAt({ type: "calendar", payload: { start: "2026-11-07T07:05:00+13:00" } }, tz)).toBe(Date.parse("2026-11-06T18:05:00Z"));
    expect(dueAt({ type: "reminder", payload: { due: "next tuesday" } }, tz)).toBeNull();
    expect(dueAt({ type: "copy", payload: {} }, tz)).toBeNull();
  });
});

describe("semantic search", () => {
  // Extraction would rewrite titles; keep the stored text exactly what we uploaded.
  beforeEach(() => {
    setup.provider.enabled = false;
  });

  test("finds by meaning when no words match", async () => {
    const token = await login();
    const wifi = ((await (await upload(token, { ocr_text: "Network: KiwiNest_5G Password: sunflower42" }, 1)).json()) as any).id;
    await upload(token, { ocr_text: "Laneway concert tickets $89" }, 2);
    await setup.worker.tick();

    const list = (await (await get(token, "/api/captures?q=internet%20details")).json()) as any;
    expect(list.items.map((i: any) => i.id)).toEqual([wifi]);
  });

  test("keyword and meaning hits merge, filters still apply", async () => {
    const token = await login();
    const a = ((await (await upload(token, { ocr_text: "router admin page" }, 1)).json()) as any).id;
    const b = ((await (await upload(token, { ocr_text: "wifi password on the fridge" }, 2)).json()) as any).id;
    const trashed = ((await (await upload(token, { ocr_text: "network password for work" }, 3)).json()) as any).id;
    await setup.worker.tick();
    await setup.app.request(`/api/captures/${trashed}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ deleted: true }),
    });

    const ids = ((await (await get(token, "/api/captures?q=wifi")).json()) as any).items.map((i: any) => i.id);
    expect(ids[0]).toBe(b); // both halves agree on b
    expect(ids).toContain(a); // meaning only
    expect(ids).not.toContain(trashed);
  });

  test("editing a note re-embeds the capture", async () => {
    const token = await login();
    const id = ((await (await upload(token, { ocr_text: "blurry photo" }, 1)).json()) as any).id;
    await setup.worker.tick();
    expect(((await (await get(token, "/api/captures?q=concert")).json()) as any).items).toHaveLength(0);

    await setup.app.request(`/api/captures/${id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note_text: "band poster" }),
    });
    await setup.worker.tick();
    const ids = ((await (await get(token, "/api/captures?q=concert")).json()) as any).items.map((i: any) => i.id);
    expect(ids).toEqual([id]);
  });

  test("fuse ranks agreement first", () => {
    expect(fuse(["a", "b", "c"], ["c", "a"])[0]).toBe("a");
    expect(fuse([], ["x"])).toEqual(["x"]);
  });
});

describe("backups", () => {
  test("one snapshot per day, oldest pruned, snapshot is a readable copy", async () => {
    const token = await login();
    await upload(token, { note: "keep me" });
    const dir = mkdtempSync(join(tmpdir(), "sink-backup-"));
    const backups = new Backups(setup.db, dir, 2);
    const path = backups.run(new Date("2026-10-20T12:00:00Z"))!;
    expect(backups.run(new Date("2026-10-20T18:00:00Z"))).toBeNull();
    backups.run(new Date("2026-10-21T12:00:00Z"));
    backups.run(new Date("2026-10-22T12:00:00Z"));
    expect(readdirSync(dir).sort()).toEqual(["sink-2026-10-21.db", "sink-2026-10-22.db"]);

    const copy = new Database(join(dir, "sink-2026-10-22.db"), { readonly: true });
    expect(copy.query<{ note_text: string }, []>("SELECT note_text FROM captures").get()!.note_text).toBe("keep me");
    copy.close();
    expect(path).toEndWith("sink-2026-10-20.db");
  });
});

describe("helpers", () => {
  test("capture time is given to the AI in the user's zone", () => {
    expect(localIso(new Date("2026-10-22T04:12:07Z"), "Pacific/Auckland")).toBe("2026-10-22T17:12:07+13:00 (Thursday)");
    expect(utcOffset(new Date("2026-07-01T00:00:00Z"), "Pacific/Auckland")).toBe("+12:00");
  });

  test("fts query is sanitized", () => {
    expect(toFtsQuery(`wifi "pass" OR -x*`)).toBe(`"wifi"* "pass"* "OR"* "x"*`);
    expect(toFtsQuery("   ")).toBeNull();
  });

  test("extraction parser tolerates fences and junk", () => {
    const e = parseExtraction('Sure!\n```json\n{"kind":"weird","title":"T","tags":"nope","actions":[{"type":"bad"}]}\n```');
    expect(e.kind).toBe("other");
    expect(e.tags).toEqual([]);
    expect(e.actions).toEqual([]);
  });
});

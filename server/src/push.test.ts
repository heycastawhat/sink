import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { Auth } from "./auth";
import { Oidc } from "./oidc";
import { createApp } from "./app";
import { Vault } from "./notes";
import { encrypt, sendReminders, vapidKeys, type Subscription } from "./push";

const PUBLIC = "https://sink.test";
const SUB = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc",
  keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
};

function makeSetup() {
  const db = openDb(":memory:");
  const vault = new Vault(db, mkdtempSync(join(tmpdir(), "sink-push-")), "UTC");
  const auth = new Auth(db);
  const oidc = new Oidc({ issuer: "https://auth.test/", clientId: "c", clientSecret: "", allowedUsers: [], allowedGroups: [], allowAnyone: true, name: "" });
  const app = createApp({ db, vault, auth, oidc, config: { secureCookies: false, maxUploadBytes: 1024 * 1024, webDir: undefined, publicUrls: [PUBLIC] } });
  const call = (token: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { db, vault, auth, call, full: auth.issueToken("browser", "me"), mcp: auth.issueToken("assistant", "me", "mcp") };
}

let s: ReturnType<typeof makeSetup>;
beforeEach(() => {
  s = makeSetup();
});

const subscribe = (at: number) => s.db.query("INSERT INTO push_subscriptions VALUES (?, ?, ?, ?)").run(SUB.endpoint, SUB.keys.p256dh, SUB.keys.auth, at);

/** A fake push service: records payloads, answers `status`. */
function fakeSender(status = 201) {
  const sent: { sub: Subscription; payload: any }[] = [];
  const send = async (sub: Subscription, payload: string) => {
    sent.push({ sub, payload: JSON.parse(payload) });
    return status;
  };
  return { sent, send };
}

const T = (iso: string) => Date.parse(iso);

describe("push routes", () => {
  test("the VAPID key is made once and kept", async () => {
    const a = vapidKeys(s.db);
    expect(Buffer.from(a.publicKey, "base64url").length).toBe(65);
    expect(vapidKeys(s.db)).toEqual(a);
    expect(await (await s.call(s.full, "GET", "/api/push/key")).json()).toEqual({ key: a.publicKey });
  });

  test("subscribe and unsubscribe", async () => {
    expect((await s.call(s.full, "POST", "/api/push/subscribe", SUB)).status).toBe(200);
    // Again (the browser re-sends it on every visit): still one.
    expect((await s.call(s.full, "POST", "/api/push/subscribe", SUB)).status).toBe(200);
    expect(s.db.query("SELECT endpoint FROM push_subscriptions").all()).toEqual([{ endpoint: SUB.endpoint }]);
    expect((await s.call(s.full, "POST", "/api/push/unsubscribe", { endpoint: SUB.endpoint })).status).toBe(200);
    expect(s.db.query("SELECT * FROM push_subscriptions").all()).toEqual([]);
  });

  test("rejects bad subscriptions", async () => {
    for (const bad of [
      { ...SUB, endpoint: "http://fcm.googleapis.com/x" },
      { ...SUB, endpoint: "https://nas.lan/x" },
      { ...SUB, endpoint: "https://fcm.googleapis.com.evil.example/x" },
      { ...SUB, endpoint: "https://fcm.googleapis.com:8443/x" },
      { ...SUB, keys: { ...SUB.keys, auth: "short" } },
      { endpoint: SUB.endpoint },
    ]) {
      expect((await s.call(s.full, "POST", "/api/push/subscribe", bad)).status).toBe(400);
    }
  });

  test("needs a full-scope sign-in", async () => {
    expect((await s.call("nope", "GET", "/api/push/key")).status).toBe(401);
    expect((await s.call(s.mcp, "GET", "/api/push/key")).status).toBe(403);
    expect((await s.call(s.mcp, "POST", "/api/push/subscribe", SUB)).status).toBe(403);
    expect((await s.call(s.mcp, "POST", "/api/push/unsubscribe", { endpoint: SUB.endpoint })).status).toBe(403);
  });
});

describe("reminders", () => {
  test("sends each reminder once, when it's due", async () => {
    subscribe(T("2026-11-01T00:00:00Z"));
    await s.vault.write("Jobs.md", "# Jobs\n\n- [ ] Call mum (@2026-11-06 18:00)\n- [ ] Pay rates 📅 2026-11-07\n- [x] Done (@2026-11-06 18:00)\n", null);
    const { sent, send } = fakeSender();
    await sendReminders([s.db], send, T("2026-11-06T17:59:00Z"));
    expect(sent).toEqual([]);
    await sendReminders([s.db], send, T("2026-11-06T18:00:30Z"));
    await sendReminders([s.db], send, T("2026-11-06T18:01:00Z"));
    expect(sent.map((x) => x.payload)).toEqual([
      { title: "Call mum", body: "Jobs", path: "Jobs.md", line: 2, tag: `Jobs.md\nCall mum\n${T("2026-11-06T18:00:00Z")}` },
    ]);
    expect(sent[0]!.sub.endpoint).toBe(SUB.endpoint);
    // A due date alone reminds at 9am.
    await sendReminders([s.db], send, T("2026-11-07T09:00:00Z"));
    expect(sent.map((x) => x.payload.title)).toEqual(["Call mum", "Pay rates"]);
  });

  test("follows edits: moved lines aren't resent, new times and removed reminders are", async () => {
    subscribe(T("2026-11-01T00:00:00Z"));
    const { sent, send } = fakeSender();
    let note = await s.vault.write("A.md", "- [ ] Call mum (@2026-11-06 18:00)\n- [ ] Other (@2026-11-06 19:00)\n", null);
    await sendReminders([s.db], send, T("2026-11-06T18:00:00Z"));
    note = await s.vault.write("A.md", "Intro\n\n- [ ] Call mum (@2026-11-06 18:00)\n- [ ] Other (@2026-11-06 20:00)\n", note.hash);
    await sendReminders([s.db], send, T("2026-11-06T18:05:00Z"));
    await sendReminders([s.db], send, T("2026-11-06T19:00:00Z"));
    note = await s.vault.write("A.md", "Intro\n\n- [ ] Call mum (@2026-11-06 18:00)\n- [ ] Other (@2026-11-06 20:30)\n", note.hash);
    await sendReminders([s.db], send, T("2026-11-06T20:00:00Z"));
    await s.vault.write("A.md", "Intro\n\n- [ ] Call mum (@2026-11-06 18:00)\n- [ ] Other\n", note.hash);
    await sendReminders([s.db], send, T("2026-11-06T20:30:00Z"));
    expect(sent.map((x) => x.payload.title)).toEqual(["Call mum"]);
  });

  test("a todo edited after its reminder isn't reminded again, and one no push service took is retried", async () => {
    subscribe(T("2026-11-01T00:00:00Z"));
    const note = await s.vault.write("A.md", "- [ ] Call mum (@2026-11-06 18:00)\n", null);
    const down = fakeSender(503);
    await sendReminders([s.db], down.send, T("2026-11-06T18:00:00Z"));
    const { sent, send } = fakeSender();
    await sendReminders([s.db], send, T("2026-11-06T18:00:30Z"));
    await s.vault.write("A.md", "- [ ] Call Mum (@2026-11-06 18:00)\n", note.hash);
    await sendReminders([s.db], send, T("2026-11-06T18:05:00Z"));
    expect(down.sent.length).toBe(1);
    expect(sent.map((x) => x.payload.title)).toEqual(["Call mum"]);
  });

  test("skips reminders from before the browser subscribed, and old ones", async () => {
    subscribe(T("2026-11-06T18:00:10Z"));
    await s.vault.write("A.md", "- [ ] Before (@2026-11-06 18:00)\n- [ ] Long ago (@2026-11-05 18:00)\n- [ ] After (@2026-11-06 18:01)\n", null);
    const { sent, send } = fakeSender();
    await sendReminders([s.db], send, T("2026-11-06T18:01:00Z"));
    expect(sent.map((x) => x.payload.title)).toEqual(["After"]);
  });

  test("drops subscriptions the push service says are gone", async () => {
    subscribe(T("2026-11-01T00:00:00Z"));
    await s.vault.write("A.md", "- [ ] One (@2026-11-06 18:00)\n- [ ] Two (@2026-11-06 18:00)\n", null);
    const { sent, send } = fakeSender(410);
    await sendReminders([s.db], send, T("2026-11-06T18:00:00Z"));
    expect(sent.length).toBe(1);
    expect(s.db.query("SELECT * FROM push_subscriptions").all()).toEqual([]);
  });

  test("a failing push service doesn't stop the rest", async () => {
    subscribe(T("2026-11-01T00:00:00Z"));
    await s.vault.write("A.md", "- [ ] One (@2026-11-06 18:00)\n- [ ] Two (@2026-11-06 18:00)\n", null);
    let calls = 0;
    await sendReminders([s.db], async () => (calls++ ? 201 : Promise.reject(new Error("down"))), T("2026-11-06T18:00:00Z"));
    expect(calls).toBe(2);
    expect(s.db.query("SELECT * FROM push_subscriptions").all().length).toBe(1);
  });
});

test("encrypts as in RFC 8291's example", async () => {
  const asPub = Buffer.from("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8", "base64url");
  const ecdh = { name: "ECDH", namedCurve: "P-256" };
  const jwk = { kty: "EC", crv: "P-256", d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", x: asPub.subarray(1, 33).toString("base64url"), y: asPub.subarray(33).toString("base64url") };
  const local = {
    privateKey: await crypto.subtle.importKey("jwk", jwk, ecdh, true, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("raw", asPub, ecdh, true, []),
  };
  const salt = new Uint8Array(Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"));
  const body = await encrypt("When I grow up, I want to be a watermelon", { endpoint: SUB.endpoint, ...SUB.keys }, local, salt);
  expect(body.toString("base64url")).toBe(
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  );
});

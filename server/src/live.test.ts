import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeSet } from "@codemirror/state";
import { openDb } from "./db";
import { Auth } from "./auth";
import { Oidc } from "./oidc";
import { createApp } from "./app";
import { Users } from "./users";
import { Vault } from "./notes";
import { diffChanges, liveFor } from "./live";

const PUBLIC = "https://sink.test";

function makeSetup() {
  const db = openDb(":memory:");
  const vaultDir = mkdtempSync(join(tmpdir(), "sink-live-"));
  const vault = new Vault(db, vaultDir);
  const auth = new Auth(db);
  const oidc = new Oidc({ issuer: "https://auth.test/", clientId: "c", clientSecret: "s", allowedUsers: [], allowedGroups: [], allowAnyone: true, name: "Test" });
  const users = new Users(db, { db, vault }, { dir: mkdtempSync(join(tmpdir(), "sink-live-users-")) });
  users.seen({ sub: "abc123", username: "sam" });
  const app = createApp({ db, vault, users, auth, oidc, config: { secureCookies: false, maxUploadBytes: 5 * 1024 * 1024, webDir: undefined, publicUrls: [PUBLIC] } });
  const token = auth.issueToken("test", "abc123");
  return { db, vault, vaultDir, app, auth, token };
}

let s: ReturnType<typeof makeSetup>;
const streams: Stream[] = [];
beforeEach(() => {
  s = makeSetup();
});
afterEach(async () => {
  for (const st of streams.splice(0)) await st.close();
});

type Event = { event: string; data: any };

/** A live client's stream: events in order, waited for by name. */
class Stream {
  events: Event[] = [];
  private waiters: (() => void)[] = [];
  private reader: { read(): Promise<{ value?: Uint8Array; done: boolean }>; cancel(): Promise<void> };
  constructor(res: Response) {
    this.reader = res.body!.getReader();
    void this.pump();
  }
  private async pump() {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event) this.events.push({ event, data: data ? JSON.parse(data) : null });
          for (const w of this.waiters.splice(0)) w();
        }
      }
    } catch {}
  }
  /** The next event called `name` not taken yet (earlier ones of other names are skipped over, not removed). */
  async next(name: string, timeoutMs = 2000): Promise<any> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const i = this.events.findIndex((e) => e.event === name);
      if (i >= 0) return this.events.splice(i, 1)[0]!.data;
      if (Date.now() > end) throw new Error(`no ${name} event; got ${this.events.map((e) => e.event).join(", ")}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }
  async close() {
    await this.reader.cancel().catch(() => {});
  }
}

async function put(path: string, content: string) {
  const res = await s.app.request("/api/notes", {
    method: "POST",
    headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" },
    body: JSON.stringify({ title: path.replace(/\.md$/, ""), content }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { path: string; hash: string };
}

async function open(path: string, client: string, extra = "") {
  const res = await s.app.request(`/api/live?path=${encodeURIComponent(path)}&client=${client}${extra}`, { headers: { authorization: `Bearer ${s.token}` } });
  expect(res.status).toBe(200);
  const st = new Stream(res);
  streams.push(st);
  return { st, hello: await st.next("hello") };
}

async function openShare(id: string, client: string, name = "", extra = "") {
  const res = await s.app.request(`/api/public/share/${id}/live?client=${client}&name=${encodeURIComponent(name)}${extra}`);
  expect(res.status).toBe(200);
  const st = new Stream(res);
  streams.push(st);
  return { st, hello: await st.next("hello") };
}

const post = (path: string, body: unknown, auth = true) =>
  s.app.request(path, {
    method: "POST",
    headers: { ...(auth && { authorization: `Bearer ${s.token}` }), "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** One client's change: `insert` at `at` in a document of `length`. */
const insert = (length: number, at: number, text: string, del = 0) => ChangeSet.of([{ from: at, to: at + del, insert: text }], length).toJSON();

const file = (path: string) => readFileSync(join(s.vaultDir, path), "utf8");

describe("live editing", () => {
  test("two people: each sees the other's change, concurrent edits both go in, and the file is written", async () => {
    await put("Plan.md", "Hello world\n");
    const a = await open("Plan.md", "clientaaa");
    const b = await open("Plan.md", "clientbbb");
    expect(a.hello.type).toBe("init");
    expect(a.hello.text).toBe("Hello world\n");
    expect(b.hello.version).toBe(0);
    // Both see two people.
    const people = (await a.st.next("presence")).people;
    expect(people.length).toBeGreaterThanOrEqual(1);
    expect((await b.st.next("presence")).people.map((p: any) => p.name)).toEqual(["sam", "sam"]);

    // Both type at version 0: A at the start, B at the end. B's goes in after A's, moved over it.
    expect((await post("/api/live/push", { conn: a.hello.conn, version: 0, updates: [{ clientID: "clientaaa", changes: insert(12, 0, "Oh, ") }] })).status).toBe(200);
    expect((await post("/api/live/push", { conn: b.hello.conn, version: 0, updates: [{ clientID: "clientbbb", changes: insert(12, 11, "!") }] })).status).toBe(200);
    const first = await b.st.next("update");
    expect(first.updates[0].clientID).toBe("clientaaa");
    const second = await a.st.next("update");
    expect(second.updates[0].clientID).toBe("clientaaa");
    expect((await a.st.next("update")).updates[0].clientID).toBe("clientbbb");

    // Not on disk yet (a moment after typing stops); "save now" writes it.
    expect(file("Plan.md")).toBe("Hello world\n");
    const saved = await post("/api/live/save", { conn: a.hello.conn });
    expect(((await saved.json()) as any).dirty).toBe(false);
    expect(file("Plan.md")).toBe("Oh, Hello world!\n");
    expect((await b.st.next("saved")).dirty).toBe(false);
  });

  test("a change made elsewhere is merged in, even over unsaved typing", async () => {
    const note = await put("Merge.md", "one\ntwo\nthree\n");
    const a = await open("Merge.md", "clientaaa");
    // Typing at the end, not saved yet.
    await post("/api/live/push", { conn: a.hello.conn, version: 0, updates: [{ clientID: "clientaaa", changes: insert(14, 14, "four\n") }] });
    await a.st.next("update");
    // Another device saves an edit to the first line, against the file as it was.
    const res = await s.app.request(`/api/notes/file?path=Merge.md`, {
      method: "PUT",
      headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" },
      body: JSON.stringify({ content: "ONE\ntwo\nthree\n", base_hash: note.hash }),
    });
    expect(res.status).toBe(200);
    const merged = await a.st.next("update");
    expect(merged.updates[0].clientID).toBe("server");
    await post("/api/live/save", { conn: a.hello.conn });
    expect(file("Merge.md")).toBe("ONE\ntwo\nthree\nfour\n");

    // An edit straight to the file (Obsidian, Syncthing), found by a scan.
    writeFileSync(join(s.vaultDir, "Merge.md"), "ONE\ntwo\nthree\nfour\nfive\n");
    await s.vault.scan();
    expect((await a.st.next("update")).updates[0].changes).toEqual(insert(19, 19, "five\n"));
    await post("/api/live/save", { conn: a.hello.conn });
    expect(file("Merge.md")).toBe("ONE\ntwo\nthree\nfour\nfive\n");
  });

  test("a reconnecting client gets what it missed, or the whole text after a restart, and can merge its own text back", async () => {
    await put("Back.md", "abc\n");
    const a = await open("Back.md", "clientaaa");
    const b = await open("Back.md", "clientbbb");
    await b.st.close();
    await post("/api/live/push", { conn: a.hello.conn, version: 0, updates: [{ clientID: "clientaaa", changes: insert(4, 3, "d") }] });
    const again = await open("Back.md", "clientbbb", `&epoch=${b.hello.epoch}&version=0`);
    expect(again.hello.type).toBe("resume");
    expect(again.hello.updates).toHaveLength(1);
    // A different room (the server restarted): the whole text, and a rejoin on the hash it last saw merges it.
    const old = await open("Back.md", "clientccc", `&epoch=stale&version=0`);
    expect(old.hello.type).toBe("init");
    expect(old.hello.text).toBe("abcd\n");
    const rejoin = await post("/api/live/rejoin", { conn: old.hello.conn, base_hash: a.hello.hash, text: "abc\nxyz\n" });
    expect(rejoin.status).toBe(200);
    await post("/api/live/save", { conn: a.hello.conn });
    expect(file("Back.md")).toBe("abcd\nxyz\n");
    // A hash the note has moved on from: nothing safe to merge onto.
    expect((await post("/api/live/rejoin", { conn: old.hello.conn, base_hash: a.hello.hash, text: "zzz" })).status).toBe(409);
  });

  test("someone else's connection or client id can't be used", async () => {
    await put("Mine.md", "x\n");
    const a = await open("Mine.md", "clientaaa");
    expect((await post("/api/live/push", { conn: a.hello.conn, version: 0, updates: [{ clientID: "clientzzz", changes: insert(2, 0, "y") }] })).status).toBe(400);
    expect((await post("/api/live/push", { conn: "nope", version: 0, updates: [] })).status).toBe(409);
    // Changes that don't fit the text.
    expect((await post("/api/live/push", { conn: a.hello.conn, version: 0, updates: [{ clientID: "clientaaa", changes: insert(50, 0, "y") }] })).status).toBe(400);
    // Another account's token can't use the connection.
    const other = s.auth.issueToken("other", "someone-else");
    const res = await s.app.request("/api/live/push", {
      method: "POST",
      headers: { authorization: `Bearer ${other}`, "content-type": "application/json" },
      body: JSON.stringify({ conn: a.hello.conn, version: 0, updates: [] }),
    });
    expect(res.status).toBe(409);
    // Assistants don't get live editing.
    const mcp = s.auth.issueToken("assistant", "abc123", "mcp");
    expect((await s.app.request(`/api/live?path=Mine.md&client=clientmcp`, { headers: { authorization: `Bearer ${mcp}` } })).status).toBe(403);
    // A share link's visitor can't take a signed-in client's id.
    const share = (await (await post("/api/notes/share", { path: "Mine.md", editable: true })).json()) as any;
    const taken = new Stream(await s.app.request(`/api/public/share/${share.id}/live?client=clientaaa&name=Kim`));
    streams.push(taken);
    expect((await taken.next("refused")).status).toBe(409);
  });

  test("share links: the body only, edits keep the frontmatter, no new properties or images, and editing can be turned off", async () => {
    await put("Trip.md", "---\ntags: [travel]\n---\n# Trip\n![[map.png]]\n");
    const share = (await (await post("/api/notes/share", { path: "Trip.md", editable: true })).json()) as any;
    const owner = await open("Trip.md", "clientown");
    const viewer = await openShare(share.id, "clientview");
    const kim = await openShare(share.id, "clientkim", "Kim");
    expect(kim.hello.text).toBe("# Trip\n![[map.png]]\n");
    // Without a name, a visitor only watches.
    expect((await post(`/api/public/share/${share.id}/live/push`, { conn: viewer.hello.conn, version: 0, updates: [{ clientID: "clientview", changes: insert(20, 0, "x") }] }, false)).status).toBe(403);

    // Kim types at the end of the body; the owner sees it after the frontmatter.
    expect((await post(`/api/public/share/${share.id}/live/push`, { conn: kim.hello.conn, version: 0, updates: [{ clientID: "clientkim", changes: insert(20, 20, "Bring snacks\n") }] }, false)).status).toBe(200);
    const seen = await owner.st.next("update");
    expect(seen.updates[0].changes).toEqual(insert(43, 43, "Bring snacks\n"));
    expect((await viewer.st.next("update")).updates[0].changes).toEqual(insert(20, 20, "Bring snacks\n"));
    expect((await kim.st.next("update")).updates[0].clientID).toBe("clientkim");

    // The owner edits the frontmatter: share links see no change (an empty one, to keep versions in step).
    await post("/api/live/push", { conn: owner.hello.conn, version: 1, updates: [{ clientID: "clientown", changes: insert(56, 4, "x", 1) }] });
    const hidden = (await kim.st.next("update")).updates[0].changes;
    expect(ChangeSet.fromJSON(hidden).empty).toBe(true);

    // No new image, no properties.
    const refused = await post(`/api/public/share/${share.id}/live/push`, { conn: kim.hello.conn, version: 2, updates: [{ clientID: "clientkim", changes: insert(33, 0, "![[secret.png]]\n") }] }, false);
    expect(refused.status).toBe(400);
    await post("/api/live/save", { conn: owner.hello.conn });
    expect(file("Trip.md")).toBe("---\nxags: [travel]\n---\n# Trip\n![[map.png]]\nBring snacks\n");
    // Recorded as the last to edit through the link.
    expect(((await (await s.app.request("/api/notes/share?path=Trip.md", { headers: { authorization: `Bearer ${s.token}` } })).json()) as any).edited_by).toBe("Kim");

    // Editing turned off: Kim is told, and can't push.
    await post("/api/notes/share", { path: "Trip.md", editable: false });
    await kim.st.next("readonly");
    expect((await post(`/api/public/share/${share.id}/live/push`, { conn: kim.hello.conn, version: 2, updates: [] }, false)).status).toBe(409);
    // Sharing stopped: the stream ends.
    await s.app.request("/api/notes/share?path=Trip.md", { method: "DELETE", headers: { authorization: `Bearer ${s.token}` } });
    await viewer.st.next("gone");
  });

  test("a share without frontmatter can't be given some by typing it", async () => {
    await put("Bare.md", "text\n");
    const share = (await (await post("/api/notes/share", { path: "Bare.md", editable: true })).json()) as any;
    const kim = await openShare(share.id, "clientkim", "Kim");
    const res = await post(`/api/public/share/${share.id}/live/push`, { conn: kim.hello.conn, version: 0, updates: [{ clientID: "clientkim", changes: insert(5, 0, "---\npublish: true\n---\n") }] }, false);
    expect(res.status).toBe(400);
  });

  test("moved and deleted notes", async () => {
    await put("Old.md", "x\n");
    const a = await open("Old.md", "clientaaa");
    await s.app.request("/api/notes/move", {
      method: "POST",
      headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" },
      body: JSON.stringify({ from: "Old.md", to: "New.md" }),
    });
    expect((await a.st.next("moved")).path).toBe("New.md");
    await post("/api/live/push", { conn: a.hello.conn, version: 0, updates: [{ clientID: "clientaaa", changes: insert(2, 0, "y") }] });
    await post("/api/live/save", { conn: a.hello.conn });
    expect(file("New.md")).toBe("yx\n");
    const del = await s.app.request("/api/notes/file?path=New.md", { method: "DELETE", headers: { authorization: `Bearer ${s.token}` } });
    expect(del.status).toBe(200);
    await a.st.next("gone");
    expect(liveFor(s.vault).room("New.md")).toBeUndefined();
  });
});

test("diffChanges turns one text into the other", () => {
  for (const [a, b] of [
    ["", "abc"],
    ["abc", ""],
    ["one two three", "one 2 three four"],
    ["😀 emoji", "😃 emoji"],
  ] as const) {
    expect(diffChanges(a, b).apply(require("@codemirror/state").Text.of(a.split("\n"))).toString()).toBe(b);
  }
});

test("a client that goes quiet is dropped, cursor and all", async () => {
  s = makeSetup();
  await put("Quiet.md", "x\n");
  const a = await open("Quiet.md", "clientaaa");
  const b = await open("Quiet.md", "clientbbb");
  const room = liveFor(s.vault).room("Quiet.md")!;
  // A keeps talking; B's tab closed without the server noticing.
  await post("/api/live/presence", { conn: a.hello.conn, version: 0, cursor: { anchor: 0, head: 0 } });
  room.peers.get(b.hello.conn)!.seen -= 120_000;
  room.reap();
  expect([...room.peers.values()].map((p) => p.clientID)).toEqual(["clientaaa"]);
  // A is told: the newest presence it got lists only A.
  await Bun.sleep(100);
  const people = a.st.events.filter((e) => e.event === "presence").at(-1)!.data.people;
  expect(people.map((p: any) => p.id)).toEqual(["clientaaa"]);
});

test("an editable share link's visitor can paste an image in, and only an image", async () => {
  s = makeSetup();
  await put("Pics.md", "text\n");
  const share = (await (await post("/api/notes/share", { path: "Pics.md", editable: true })).json()) as any;
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (ch) => ch.charCodeAt(0));
  const upload = (bytes: Uint8Array, name: string, id = share.id) => {
    const form = new FormData();
    form.set("file", new File([bytes], name));
    return s.app.request(`/api/public/share/${id}/attachment`, { method: "POST", body: form });
  };
  // Not an image, whatever it's called.
  expect((await upload(new TextEncoder().encode("<script>"), "x.png")).status).toBe(400);
  const res = await upload(png, "whatever.html");
  expect(res.status).toBe(201);
  const { embed } = (await res.json()) as { embed: string };
  expect(embed).toMatch(/^!\[\[Pasted image \d{14} [\w-]{6}\.png\]\]$/);
  const name = embed.slice(3, -2);
  // Served at once (a live edit can show it before the note is written), and the visitor's edit may embed it.
  expect((await s.app.request(`/api/public/share/${share.id}/attachment?name=${encodeURIComponent(name)}`)).status).toBe(200);
  const kim = await openShare(share.id, "clientkim", "Kim");
  const ok = await post(`/api/public/share/${share.id}/live/push`, { conn: kim.hello.conn, version: 0, updates: [{ clientID: "clientkim", changes: insert(5, 5, embed + "\n") }] }, false);
  expect(ok.status).toBe(200);
  await post(`/api/public/share/${share.id}/live/save`, { conn: kim.hello.conn }, false);
  expect(file("Pics.md")).toBe(`text\n${embed}\n`);
  // A read-only link takes no uploads.
  await post("/api/notes/share", { path: "Pics.md", editable: false });
  expect((await upload(png, "a.png")).status).toBe(404);
});

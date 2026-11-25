import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { openDb } from "./db";
import { Auth } from "./auth";
import { Oidc } from "./oidc";
import { createApp } from "./app";
import { Users } from "./users";
import { Vault } from "./notes";
import { diffDelta, liveFor, liveSocket, SYNC_STEP1, SYNC_STEP2, UPDATE } from "./live";

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
  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: liveSocket });
  return { db, vault, vaultDir, app, auth, token, server, ws: `ws://localhost:${server.port}` };
}

let s: ReturnType<typeof makeSetup>;
const clients: Client[] = [];
beforeEach(() => {
  s = makeSetup();
});
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  s.server.stop(true);
});

const frame = (type: number, payload: Uint8Array) => new Uint8Array([type, ...payload]);
const until = async (ok: () => boolean, what: string, ms = 2000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

/** A live client as the web app runs one: its own Yjs copy, synced over the socket. */
class Client {
  ws!: WebSocket;
  messages: any[] = [];
  acks = 0;
  synced = false;
  closed = false;
  constructor(public doc = new Y.Doc()) {
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "remote" && this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame(UPDATE, update));
    });
  }
  connect(url: string, headers: Record<string, string> = {}) {
    this.synced = false;
    this.closed = false;
    this.ws = new WebSocket(url, { headers } as any);
    this.ws.binaryType = "arraybuffer";
    this.ws.onclose = () => (this.closed = true);
    this.ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        const msg = JSON.parse(e.data);
        if (msg.t === "ack") this.acks++;
        else this.messages.push(msg);
        if (msg.t === "hello") {
          // Someone else's document (a fresh client, or after the server lost track of it): start from the server's.
          if (msg.guid !== this.doc.guid) {
            const old = this.doc;
            this.doc = new Y.Doc({ guid: msg.guid });
            this.doc.on("update", (update: Uint8Array, origin: unknown) => {
              if (origin !== "remote" && this.ws.readyState === WebSocket.OPEN) this.ws.send(frame(UPDATE, update));
            });
            old.destroy();
          }
          this.ws.send(frame(SYNC_STEP1, Y.encodeStateVector(this.doc)));
        }
        return;
      }
      const data = new Uint8Array(e.data);
      if (data[0] === SYNC_STEP1) this.ws.send(frame(SYNC_STEP2, Y.encodeStateAsUpdate(this.doc, data.subarray(1))));
      else {
        Y.applyUpdate(this.doc, data.subarray(1), "remote");
        if (data[0] === SYNC_STEP2) this.synced = true;
      }
    };
    return this;
  }
  get text() {
    return this.doc.getText("t").toString();
  }
  insert(at: number, text: string) {
    this.doc.getText("t").insert(at, text);
  }
  delete(at: number, length: number) {
    this.doc.getText("t").delete(at, length);
  }
  send(msg: unknown) {
    this.ws.send(JSON.stringify(msg));
  }
  cursor(at: number) {
    const rel = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.doc.getText("t"), at));
    this.send({ t: "cursor", anchor: rel, head: rel });
  }
  /** The next message of type `t` not taken yet. */
  async next(t: string, ms = 2000) {
    await until(() => this.messages.some((m) => m.t === t), `${t}; got ${this.messages.map((m) => m.t).join(", ")}`, ms);
    return this.messages.splice(
      this.messages.findIndex((m) => m.t === t),
      1,
    )[0];
  }
  close() {
    this.ws?.close();
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

async function open(path: string, doc?: Y.Doc) {
  const c = new Client(doc).connect(`${s.ws}/api/live?path=${encodeURIComponent(path)}`, { authorization: `Bearer ${s.token}` });
  clients.push(c);
  await until(() => c.synced, "sync");
  return c;
}

async function openShare(id: string, name = "") {
  const c = new Client().connect(`${s.ws}/api/public/share/${id}/live?name=${encodeURIComponent(name)}`);
  clients.push(c);
  await until(() => c.synced, "sync");
  return c;
}

const post = (path: string, body: unknown) =>
  s.app.request(path, { method: "POST", headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

/** "Save now", as the editor asks before leaving a note. */
async function save(c: Client) {
  await Bun.sleep(20);
  c.messages = c.messages.filter((m) => m.t !== "saved");
  c.send({ t: "save" });
  return c.next("saved");
}

const file = (path: string) => readFileSync(join(s.vaultDir, path), "utf8");

const write = (path: string, content: string, baseHash: string, doc?: Y.Doc) =>
  s.app.request(`/api/notes/file?path=${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      content,
      base_hash: baseHash,
      live: doc && { guid: doc.guid, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64") },
    }),
  });

describe("live editing", () => {
  for (const delivery of ["discarded", "after fallback", "before fallback"]) {
    test(`a live fallback writes one insertion when socket delivery is ${delivery}`, async () => {
      const initial = await put("Handoff.md", "Hello\n");
      const android = await open(initial.path);
      const observer = await open(initial.path);
      const update = new Promise<Uint8Array>((resolve) => android.doc.once("update", resolve));
      const send = android.ws.send.bind(android.ws);
      android.ws.send = () => {};
      android.insert(5, " Android");
      const frameToDeliver = frame(UPDATE, await update);
      if (delivery === "before fallback") {
        send(frameToDeliver);
        await until(() => observer.text === "Hello Android\n", "original socket edit accepted");
        expect(file(initial.path)).toBe("Hello\n");
      }
      const res = await write(initial.path, android.text, initial.hash, android.doc);
      expect(res.status).toBe(200);
      if (delivery === "after fallback") {
        const acks = android.acks;
        send(frameToDeliver);
        await until(() => android.acks > acks, "delayed socket edit accepted");
      }
      await liveFor(s.vault).flush();
      await until(() => observer.text.includes(" Android"), "fallback relayed to the other peer");
      expect(observer.text).toBe("Hello Android\n");
      expect(file(initial.path)).toBe("Hello Android\n");
    });
  }

  test("a live fallback keeps a newer committed edit as a hash conflict", async () => {
    const initial = await put("Handoff.md", "Hello\n");
    const android = await open(initial.path);
    android.ws.send = () => {};
    android.insert(5, " Android");
    const other = await write(initial.path, "Hello PWA\n", initial.hash);
    expect(other.status).toBe(200);
    const conflict = await write(initial.path, "Hello Android\n", initial.hash, android.doc);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ current: { content: "Hello PWA\n" } });
    expect(file(initial.path)).toBe("Hello PWA\n");
  });

  test("a live fallback keeps unpublished changes from another live peer", async () => {
    const initial = await put("Handoff.md", "Hello\n");
    const android = await open(initial.path);
    const other = await open(initial.path);
    android.ws.send = () => {};
    android.insert(5, " Android");
    const snapshot = Buffer.from(Y.encodeStateAsUpdate(android.doc));
    other.insert(0, "PWA: ");
    await until(() => android.text.startsWith("PWA: "), "other peer's update");
    const offline = new Y.Doc({ guid: android.doc.guid });
    Y.applyUpdate(offline, snapshot);
    expect((await write(initial.path, "Hello Android\n", initial.hash, offline)).status).toBe(200);
    offline.destroy();
    await liveFor(s.vault).flush();
    expect(file(initial.path)).toBe("PWA: Hello Android\n");
  });

  test("two people: each sees the other's typing, concurrent edits both go in, and the file is written", async () => {
    await put("Plan.md", "Hello world\n");
    const a = await open("Plan.md");
    const b = await open("Plan.md");
    expect(a.text).toBe("Hello world\n");
    await until(() => b.messages.some((m) => m.t === "presence" && m.people.length === 2), "two people");
    expect(b.messages.findLast((m) => m.t === "presence").people.map((p: any) => p.name)).toEqual(["sam", "sam"]);

    // Both type at once, neither having seen the other's change.
    a.insert(0, "Oh, ");
    b.insert(11, "!");
    await until(() => a.text === "Oh, Hello world!\n" && b.text === a.text, "both changes everywhere");

    // Not on disk yet (a moment after typing stops); "save now" writes it.
    expect(file("Plan.md")).toBe("Hello world\n");
    expect((await save(a)).dirty).toBe(false);
    expect(file("Plan.md")).toBe("Oh, Hello world!\n");

    // Cursors reach the others, as positions in their own copy.
    a.cursor(4);
    await until(() => b.messages.some((m) => m.t === "presence" && m.people.some((p: any) => !p.me && p.cursor)), "a's cursor");
    const cursor = b.messages.findLast((m) => m.t === "presence").people.find((p: any) => !p.me).cursor;
    expect(Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.head), b.doc)!.index).toBe(4);
  });

  test("typing is written by itself a moment after it stops", async () => {
    await put("Auto.md", "a\n");
    const c = await open("Auto.md");
    c.insert(1, "b");
    await until(() => file("Auto.md") === "ab\n", "the write", 3000);
    expect((await c.next("saved")).dirty).toBe(false);
  });

  test("a change made elsewhere is merged in, even over unsaved typing", async () => {
    const note = await put("Merge.md", "one\ntwo\nthree\n");
    const a = await open("Merge.md");
    // Typing at the end, not saved yet.
    a.insert(14, "four\n");
    await until(() => a.acks > 0, "ack");
    // Another device saves an edit to the first line, against the file as it was.
    const res = await s.app.request(`/api/notes/file?path=Merge.md`, {
      method: "PUT",
      headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" },
      body: JSON.stringify({ content: "ONE\ntwo\nthree\n", base_hash: note.hash }),
    });
    expect(res.status).toBe(200);
    await until(() => a.text === "ONE\ntwo\nthree\nfour\n", "the outside edit");
    await save(a);
    expect(file("Merge.md")).toBe("ONE\ntwo\nthree\nfour\n");

    // An edit straight to the file (Obsidian, Syncthing), found by a scan, while someone types at the start.
    a.insert(0, "# ");
    writeFileSync(join(s.vaultDir, "Merge.md"), "ONE\ntwo\nthree\nfour\nfive\n");
    await s.vault.scan();
    await until(() => a.text === "# ONE\ntwo\nthree\nfour\nfive\n", "the scanned edit");
    await save(a);
    expect(file("Merge.md")).toBe("# ONE\ntwo\nthree\nfour\nfive\n");
  });

  test("offline typing syncs on reconnect, also after the server restarts, without doubling anything", async () => {
    await put("Back.md", "abc\n");
    const a = await open("Back.md");
    const b = await open("Back.md");
    // B goes offline and types; A types meanwhile.
    b.close();
    await until(() => b.closed, "b closed");
    b.insert(4, "from b\n");
    a.insert(0, "A: ");
    await until(() => a.acks > 0, "ack");
    // B comes back with the same copy: each gets the other's change.
    await open("Back.md", b.doc);
    await until(() => a.text === "A: abc\nfrom b\n" && clients.at(-1)!.text === a.text, "merged");
    await save(a);

    // The server restarts (the room is gone), while C, offline, holds a copy with typing the room never saw.
    const c = await open("Back.md");
    c.close();
    await until(() => c.closed, "c closed");
    c.insert(0, ">> ");
    for (const cl of clients) cl.close();
    await liveFor(s.vault).flush();
    await until(() => [...liveFor(s.vault).room("Back.md")!.peers.keys()].length === 0, "everyone gone");
    (liveFor(s.vault).room("Back.md") as any).close();
    expect(liveFor(s.vault).room("Back.md")).toBeUndefined();
    // The new room picks up the stored document, so C's copy syncs into it rather than beside it.
    const again = await open("Back.md", c.doc);
    await until(() => again.text === ">> A: abc\nfrom b\n", "c's typing merged once");
    await save(again);
    expect(file("Back.md")).toBe(">> A: abc\nfrom b\n");
  });

  test("assistants and other sites' pages don't get live editing", async () => {
    await put("Mine.md", "x\n");
    const mcp = s.auth.issueToken("assistant", "abc123", "mcp");
    expect((await s.app.request(`/api/live?path=Mine.md`, { headers: { authorization: `Bearer ${mcp}` } })).status).toBe(403);
    // A socket carries the session cookie from any page: only Sink's own may open one with it.
    const session = s.auth.issueToken("web", "abc123");
    const cookie = `sink_session=${session}`;
    const upgrade = { upgrade: "websocket", connection: "upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
    expect((await fetch(`http://localhost:${s.server.port}/api/live?path=Mine.md`, { headers: { ...upgrade, cookie, origin: "https://evil.test" } })).status).toBe(403);
    // A plain GET (a client asking whether live editing is here, after its socket failed) sends no Origin.
    expect((await fetch(`http://localhost:${s.server.port}/api/live?path=Mine.md`, { headers: { cookie } })).status).toBe(426);
  });

  test("share links: the body only, edits keep the frontmatter, no new properties or images, and editing can be turned off", async () => {
    await put("Trip.md", "---\ntags: [travel]\n---\n# Trip\n![[map.png]]\n");
    const share = (await (await post("/api/notes/share", { path: "Trip.md", editable: true })).json()) as any;
    const owner = await open("Trip.md");
    const viewer = await openShare(share.id);
    const kim = await openShare(share.id, "Kim");
    expect(kim.text).toBe("# Trip\n![[map.png]]\n");
    // Without a name, a visitor only watches: what they type goes nowhere.
    viewer.insert(0, "x");
    await until(() => viewer.acks > 0, "viewer ack");

    // Kim types at the end of the body; the owner sees it after the frontmatter, the viewer too.
    kim.insert(20, "Bring snacks\n");
    await until(() => owner.text === "---\ntags: [travel]\n---\n# Trip\n![[map.png]]\nBring snacks\n", "kim's edit for the owner");
    // The viewer's own stray "x" stays with them alone.
    await until(() => viewer.text === "x# Trip\n![[map.png]]\nBring snacks\n", "kim's edit for the viewer");

    // The owner edits the frontmatter and the body: share links see only the body change.
    owner.delete(4, 1);
    owner.insert(3 + 19, "## ");
    await until(() => kim.text === "## # Trip\n![[map.png]]\nBring snacks\n", "the owner's body edit");
    owner.delete(22, 3);
    await until(() => kim.text === "# Trip\n![[map.png]]\nBring snacks\n", "undone");

    // No new image, no properties: refused, and undone for everyone.
    kim.insert(0, "![[secret.png]]\n");
    expect((await kim.next("refused")).error).toMatch(/images/);
    await until(() => kim.text === "# Trip\n![[map.png]]\nBring snacks\n", "the image undone");
    await save(owner);
    expect(file("Trip.md")).toBe("---\nags: [travel]\n---\n# Trip\n![[map.png]]\nBring snacks\n");
    // Recorded as the last to edit through the link.
    expect(((await (await s.app.request("/api/notes/share?path=Trip.md", { headers: { authorization: `Bearer ${s.token}` } })).json()) as any).edited_by).toBe("Kim");

    // Editing turned off: Kim is told, and what she types goes nowhere.
    await post("/api/notes/share", { path: "Trip.md", editable: false });
    await kim.next("readonly");
    kim.insert(0, "zzz");
    await until(() => kim.acks > 2, "kim ack");
    await save(owner);
    expect(file("Trip.md")).not.toContain("zzz");
    // Sharing stopped: the socket closes.
    await s.app.request("/api/notes/share?path=Trip.md", { method: "DELETE", headers: { authorization: `Bearer ${s.token}` } });
    await viewer.next("gone");
    await until(() => viewer.closed, "viewer closed");
  });

  test("a share without frontmatter can't be given some by typing it", async () => {
    await put("Bare.md", "text\n");
    const share = (await (await post("/api/notes/share", { path: "Bare.md", editable: true })).json()) as any;
    const kim = await openShare(share.id, "Kim");
    kim.insert(0, "---\npublish: true\n---\n");
    expect((await kim.next("refused")).error).toMatch(/properties/);
    await until(() => kim.text === "text\n", "undone");
  });

  test("moved and deleted notes, and their stored documents", async () => {
    await put("Old.md", "x\n");
    const a = await open("Old.md");
    await post("/api/notes/move", { from: "Old.md", to: "New.md" });
    expect((await a.next("moved")).path).toBe("New.md");
    expect(s.db.query("SELECT path FROM live_docs").all()).toEqual([{ path: "New.md" }]);
    a.insert(0, "y");
    await save(a);
    expect(file("New.md")).toBe("yx\n");
    const del = await s.app.request("/api/notes/file?path=New.md", { method: "DELETE", headers: { authorization: `Bearer ${s.token}` } });
    expect(del.status).toBe(200);
    await a.next("gone");
    expect(liveFor(s.vault).room("New.md")).toBeUndefined();
    expect(s.db.query("SELECT path FROM live_docs").all()).toEqual([]);
  });

  test("an editable share link's visitor can paste an image in, and only an image", async () => {
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
    const kim = await openShare(share.id, "Kim");
    kim.insert(5, embed + "\n");
    await save(kim);
    expect(file("Pics.md")).toBe(`text\n${embed}\n`);
    expect(kim.messages.some((m) => m.t === "refused")).toBe(false);
    // A read-only link takes no uploads.
    await post("/api/notes/share", { path: "Pics.md", editable: false });
    expect((await upload(png, "a.png")).status).toBe(404);
  });
});

test("diffDelta turns one text into the other", () => {
  for (const [a, b] of [
    ["", "abc"],
    ["abc", ""],
    ["one two three", "one 2 three four"],
    ["😀 emoji", "😃 emoji"],
  ] as const) {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, a);
    doc.getText("t").applyDelta(diffDelta(a, b));
    expect(doc.getText("t").toString()).toBe(b);
  }
});

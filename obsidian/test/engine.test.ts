import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OfflineError } from "../src/api";
import { trackFolderRename, trackRename } from "../src/engine";
import { bridge, device, server, type Server } from "./helpers";

let s: Server;
beforeEach(() => {
  s = server();
});

const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

describe("syncing a vault with a real Sink server", () => {
  test("a note written here reaches the server, and one written there reaches here", async () => {
    const d = device(s);
    d.local.edit("Ideas/Boats.md", "# Boats\nsail");
    await s.edit("Garden.md", "# Garden\nsoil");
    const r = await d.sync({ scan: true });
    expect(r).toMatchObject({ pushed: 1, pulled: 1, errors: [], conflicts: [], offline: false });
    expect(s.read("Ideas/Boats.md")).toBe("# Boats\nsail");
    expect(d.local.read("Garden.md")).toBe("# Garden\nsoil");
    // Level now: nothing more to do.
    expect(await d.sync()).toMatchObject({ pushed: 0, pulled: 0, deleted: 0 });
  });

  test("edits go both ways, one note each", async () => {
    const d = device(s);
    d.local.edit("a.md", "a1");
    d.local.edit("b.md", "b1");
    await d.sync();
    d.local.edit("a.md", "a2 from here");
    await s.edit("b.md", "b2 from there");
    expect(await d.sync({ scan: true })).toMatchObject({ pushed: 1, pulled: 1 });
    expect(s.read("a.md")).toBe("a2 from here");
    expect(d.local.read("b.md")).toBe("b2 from there");
  });

  test("the first sync into a vault that already has notes merges: nothing is overwritten, nothing is lost", async () => {
    await s.edit("same.md", "same text");
    await s.edit("server only.md", "server");
    await s.edit("clash.md", "THE SERVER'S");
    const d = device(s);
    d.local.edit("same.md", "same text");
    d.local.edit("local only.md", "local");
    d.local.edit("clash.md", "MINE");
    const r = await d.sync({ scan: true });
    expect(r.conflicts).toEqual(["clash (conflict 2026-11-02).md"]);
    expect(r.errors).toEqual([]);
    // The server's text holds the name; mine is beside it, and went up too.
    expect(d.local.read("clash.md")).toBe("THE SERVER'S");
    expect(d.local.read("clash (conflict 2026-11-02).md")).toBe("MINE");
    expect(s.read("clash (conflict 2026-11-02).md")).toBe("MINE");
    expect(s.read("clash.md")).toBe("THE SERVER'S");
    expect(d.local.read("server only.md")).toBe("server");
    expect(s.read("local only.md")).toBe("local");
    expect(r.conflictCopies).toBe(1);
    expect(d.local.paths()).toEqual(s.paths());
  });

  test("a note edited on both sides keeps both versions", async () => {
    const d = device(s);
    d.local.edit("Plan.md", "# Plan\n- one");
    await d.sync();
    d.local.edit("Plan.md", "# Plan\n- one\n- mine");
    await s.edit("Plan.md", "# Plan\n- one\n- theirs");
    const r = await d.sync({ scan: true });
    expect(r.conflicts).toEqual(["Plan (conflict 2026-11-02).md"]);
    expect(d.local.read("Plan.md")).toBe("# Plan\n- one\n- theirs");
    expect(d.local.read("Plan (conflict 2026-11-02).md")).toBe("# Plan\n- one\n- mine");
    expect(s.read("Plan (conflict 2026-11-02).md")).toBe("# Plan\n- one\n- mine");
    // Settled: the next sync finds nothing to do, and doesn't make another copy.
    expect(await d.sync()).toMatchObject({ pushed: 0, pulled: 0, conflicts: [], conflictCopies: 1 });
  });

  test("a push that finds the server's note changed meanwhile keeps both", async () => {
    let interfere = false;
    const d = device(s, {
      http: bridge(s, async (req) => {
        if (interfere && req.method === "PUT") {
          interfere = false;
          await s.edit("Race.md", "server got there first");
        }
      }),
    });
    d.local.edit("Race.md", "v1");
    await d.sync();
    d.local.edit("Race.md", "mine");
    interfere = true;
    const r = await d.sync();
    expect(r.conflicts).toEqual(["Race (conflict 2026-11-02).md"]);
    expect(d.local.read("Race.md")).toBe("server got there first");
    expect(s.read("Race (conflict 2026-11-02).md")).toBe("mine");
  });

  test("a note edited here while a pull is writing it is not overwritten", async () => {
    const d = device(s);
    d.local.edit("Live.md", "v1");
    await d.sync();
    await s.edit("Live.md", "from the server");
    d.local.beforeWrite = (path) => {
      d.local.beforeWrite = undefined;
      if (path === "Live.md") d.local.edit("Live.md", "typed just now");
    };
    const r = await d.sync({ scan: true });
    // The pull backed off, saw the new edit, and kept both versions on the next round.
    expect(r.pulled).toBe(0);
    expect(r.conflicts).toEqual(["Live (conflict 2026-11-02).md"]);
    expect(d.local.read("Live.md")).toBe("from the server");
    expect(d.local.read("Live (conflict 2026-11-02).md")).toBe("typed just now");
  });

  test("deleting a note here sends it to Sink's trash; deleting it there sends it to the vault's trash", async () => {
    const d = device(s);
    d.local.edit("mine.md", "m");
    d.local.edit("theirs.md", "t");
    await d.sync();
    await d.local.trash("mine.md");
    await s.remove("theirs.md");
    const r = await d.sync({ scan: true });
    expect(r).toMatchObject({ deleted: 2, errors: [] });
    expect(s.has("mine.md")).toBe(false);
    expect(readFileSync(join(s.vaultDir, ".trash/mine.md"), "utf8")).toBe("m");
    expect(d.local.has("theirs.md")).toBe(false);
    expect(d.local.trashed()).toEqual([".trash/mine.md", ".trash/theirs.md"]);
    expect(await d.sync({ scan: true })).toMatchObject({ deleted: 0 });
  });

  test("a note deleted on the server but edited here since comes back to the server", async () => {
    const d = device(s);
    d.local.edit("Keep.md", "v1");
    await d.sync();
    await s.remove("Keep.md");
    d.local.edit("Keep.md", "v2, I was still working on it");
    await d.sync({ scan: true });
    expect(s.read("Keep.md")).toBe("v2, I was still working on it");
  });

  test("a note edited on the server but deleted here comes back here", async () => {
    const d = device(s);
    d.local.edit("Back.md", "v1");
    await d.sync();
    await d.local.trash("Back.md");
    await s.edit("Back.md", "v2");
    await d.sync({ scan: true });
    expect(d.local.read("Back.md")).toBe("v2");
  });

  test("a rename is a move on the server, not a delete and upload", async () => {
    const d = device(s);
    d.local.edit("Old name.md", "# Old\nbody");
    d.local.edit("Index.md", "see [[Old name]]");
    await d.sync();
    d.local.rename("Old name.md", "Notes/New name.md");
    trackRename(d.state, "Old name.md", "Notes/New name.md");
    // Obsidian rewrites links on rename; the server does too, to the same text.
    d.local.edit("Index.md", "see [[New name]]");
    const r = await d.sync();
    expect(r.errors).toEqual([]);
    expect(s.read("Notes/New name.md")).toBe("# Old\nbody");
    expect(s.has("Old name.md")).toBe(false);
    expect(s.read("Index.md")).toBe("see [[New name]]");
    // Moved, not deleted: nothing in the trash, no conflict copy, and the history came along.
    expect(s.paths().filter((p) => p.includes("conflict"))).toEqual([]);
    expect(existsSync(join(s.vaultDir, ".trash"))).toBe(false);
    expect(await d.sync()).toMatchObject({ pushed: 0, pulled: 0, deleted: 0, conflicts: [] });
    expect(d.state.renames).toEqual([]);
  });

  test("a renamed note that the server changed meanwhile isn't moved over it", async () => {
    const d = device(s);
    d.local.edit("A.md", "v1");
    await d.sync();
    d.local.rename("A.md", "B.md");
    trackRename(d.state, "A.md", "B.md");
    await s.edit("A.md", "v2 on the server");
    await d.sync({ scan: true });
    // Nothing is lost: the server's edit stays at the old name, the renamed note is up at the new one.
    expect(s.read("A.md")).toBe("v2 on the server");
    expect(s.read("B.md")).toBe("v1");
    expect(d.local.read("A.md")).toBe("v2 on the server");
  });

  test("renaming a folder moves each note in it", async () => {
    const d = device(s);
    d.local.edit("Work/a.md", "a");
    d.local.edit("Work/deep/b.md", "b");
    await d.sync();
    d.local.rename("Work/a.md", "Job/a.md");
    d.local.rename("Work/deep/b.md", "Job/deep/b.md");
    trackFolderRename(d.state, "Work", "Job");
    const r = await d.sync();
    expect(r).toMatchObject({ errors: [], deleted: 0 });
    expect(s.paths().sort()).toEqual(["Job/a.md", "Job/deep/b.md"]);
    expect(existsSync(join(s.vaultDir, ".trash"))).toBe(false);
  });

  test("a rename done without telling the engine still works, as a delete and an upload", async () => {
    const d = device(s);
    d.local.edit("Before.md", "text");
    await d.sync();
    d.local.rename("Before.md", "After.md");
    await d.sync();
    expect(s.paths()).toEqual(["After.md"]);
    expect(s.read(".trash/Before.md")).toBe("text");
  });

  test("offline: edits stay, and go up when the connection is back", async () => {
    let online = false;
    const inner = bridge(s);
    const d = device(s, {
      http: async (req) => {
        if (!online) throw new Error("network down");
        return inner(req);
      },
    });
    d.local.edit("Trip.md", "packing list");
    const r = await d.sync();
    expect(r.offline).toBe(true);
    expect(d.local.read("Trip.md")).toBe("packing list");
    expect(s.paths()).toEqual([]);

    online = true;
    expect(await d.sync()).toMatchObject({ offline: false, pushed: 1 });
    expect(s.read("Trip.md")).toBe("packing list");

    // And edits made while away, after a sync, wait the same way.
    online = false;
    d.local.edit("Trip.md", "packing list, plus socks");
    expect((await d.sync()).offline).toBe(true);
    online = true;
    await d.sync();
    expect(s.read("Trip.md")).toBe("packing list, plus socks");
  });

  test("a server that answers 503 (its storage is away) counts as offline, and nothing is deleted", async () => {
    const d = device(s);
    d.local.edit("Safe.md", "x");
    await d.sync();
    const down = device(s, { http: async () => ({ status: 503, text: "{}", arrayBuffer: new ArrayBuffer(0) }) });
    Object.assign(down.state, d.state);
    expect((await down.sync()).offline).toBe(true);
    expect(d.local.read("Safe.md")).toBe("x");
  });

  test("an empty server (a share that didn't mount) can't empty the vault by itself", async () => {
    const d = device(s);
    for (let i = 0; i < 12; i++) d.local.edit(`n${i}.md`, `note ${i}`);
    await d.sync();
    for (let i = 0; i < 12; i++) await s.remove(`n${i}.md`);
    const held = await d.sync({ scan: true });
    expect(held.blocked).toEqual({ local: 12, remote: 0 });
    expect(d.local.paths().length).toBe(12);

    // Confirmed, they go to the vault's trash, still recoverable.
    const done = await d.sync({ confirmDeletes: true });
    expect(done).toMatchObject({ deleted: 12, blocked: null });
    expect(d.local.trashed().length).toBe(12);
  });

  test("a note missing from the server's index but still there isn't deleted here", async () => {
    const d = device(s);
    d.local.edit("Indexed.md", "x");
    await d.sync();
    // The index lost it (a rebuilt database); the file is on disk.
    (s.vault as any).db.query("DELETE FROM notes WHERE path = 'Indexed.md'").run();
    const r = await d.sync();
    expect(r.deleted).toBe(0);
    expect(d.local.read("Indexed.md")).toBe("x");
    expect(await d.sync()).toMatchObject({ pushed: 0, deleted: 0, conflicts: [] });
  });

  test("hidden and unsyncable files never leave the vault", async () => {
    const d = device(s);
    d.local.edit(".obsidian/app.json", "{}");
    d.local.edit(".obsidian/plugins/sink/data.json", '{"token":"secret"}');
    d.local.edit(".trash/old.md", "x");
    d.local.edit("node_modules/pkg/readme.md", "x");
    d.local.edit("bad:name.md", "x");
    d.local.edit("ok.md", "x");
    expect(await d.sync()).toMatchObject({ pushed: 1, errors: [] });
    expect(s.paths()).toEqual(["ok.md"]);
  });
});

describe("attachments", () => {
  test("images and other files sync both ways, byte for byte", async () => {
    const d = device(s);
    d.local.edit("attachments/cat.png", png);
    d.local.edit("note.md", "![[cat.png]]");
    await s.edit("docs/manual.pdf", new Uint8Array([0, 1, 2, 255, 254]));
    const r = await d.sync({ scan: true });
    expect(r).toMatchObject({ pushed: 2, pulled: 1, errors: [] });
    expect(readFileSync(join(s.vaultDir, "attachments/cat.png"))).toEqual(Buffer.from(png));
    expect(readFileSync(join(d.local.dir, "docs/manual.pdf"))).toEqual(Buffer.from([0, 1, 2, 255, 254]));
    expect(await d.sync({ scan: true })).toMatchObject({ pushed: 0, pulled: 0 });
  });

  test("a file edited here is pushed against the server's hash, and a clash keeps both", async () => {
    const d = device(s);
    d.local.edit("data.bin", new Uint8Array([1, 2, 3]));
    await d.sync();
    d.local.edit("data.bin", new Uint8Array([1, 2, 3, 4]));
    await d.sync();
    expect(readFileSync(join(s.vaultDir, "data.bin"))).toEqual(Buffer.from([1, 2, 3, 4]));

    d.local.edit("data.bin", new Uint8Array([9, 9]));
    await s.edit("data.bin", new Uint8Array([7, 7, 7]));
    const r = await d.sync({ scan: true });
    expect(r.conflicts).toEqual(["data (conflict 2026-11-02).bin"]);
    expect(readFileSync(join(d.local.dir, "data.bin"))).toEqual(Buffer.from([7, 7, 7]));
    expect(readFileSync(join(d.local.dir, "data (conflict 2026-11-02).bin"))).toEqual(Buffer.from([9, 9]));
    expect(readFileSync(join(s.vaultDir, "data (conflict 2026-11-02).bin"))).toEqual(Buffer.from([9, 9]));
  });

  test("deleting and renaming a file here follow on the server", async () => {
    const d = device(s);
    d.local.edit("img/a.png", png);
    d.local.edit("img/b.png", new Uint8Array([...png, 1]));
    await d.sync();
    await d.local.trash("img/a.png");
    d.local.rename("img/b.png", "pics/b.png");
    trackRename(d.state, "img/b.png", "pics/b.png");
    expect(await d.sync()).toMatchObject({ deleted: 1, errors: [] });
    expect(s.paths()).toEqual(["pics/b.png"]);
    expect(existsSync(join(s.vaultDir, ".trash/img/a.png"))).toBe(true);
  });

  test("a file that's too big for the server is reported, and the rest still syncs", async () => {
    const d = device(s);
    d.local.edit("huge.bin", new Uint8Array(6 * 1024 * 1024));
    d.local.edit("fine.md", "ok");
    const r = await d.sync();
    expect(r.pushed).toBe(1);
    expect(r.errors).toEqual([{ path: "huge.bin", message: "too large" }]);
    expect(d.local.has("huge.bin")).toBe(true);
  });

  test("the picture reaches the server before the note that shows it", async () => {
    const order: string[] = [];
    const d = device(s, {
      http: bridge(s, (req) => {
        if (req.method === "PUT") order.push(new URL(req.url).pathname.endsWith("attachment") ? "file" : "note");
      }),
    });
    d.local.edit("z.md", "![[p.png]]");
    d.local.edit("p.png", png);
    await d.sync();
    expect(order).toEqual(["file", "note"]);
  });
});

test("a sync that's cut off halfway resumes cleanly", async () => {
  let puts = 0;
  const d = device(s, {
    http: bridge(s, (req) => {
      if (req.method === "PUT" && ++puts === 3) throw new OfflineError("cut");
    }),
  });
  for (let i = 0; i < 6; i++) d.local.edit(`n${i}.md`, `note ${i}`);
  expect((await d.sync()).offline).toBe(true);
  expect(s.paths().length).toBeLessThan(6);
  expect(await d.sync()).toMatchObject({ offline: false, errors: [], conflicts: [] });
  expect(s.paths()).toEqual(d.local.paths());
});

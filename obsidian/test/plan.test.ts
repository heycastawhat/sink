import { describe, expect, test } from "bun:test";
import { massDeletes, plan, type Plan } from "../src/plan";
import { conflictPath, isConflictCopy, syncable } from "../src/paths";
import { emptyState, trackFolderRename, trackRename } from "../src/engine";

const maps = (local: Record<string, string>, remote: Record<string, string>, synced: Record<string, string>) =>
  plan(new Map(Object.entries(local)), new Map(Object.entries(remote)), new Map(Object.entries(synced)));

// Only one thing should be planned for a lone path; this names it.
const only = (p: Plan) => {
  const found = Object.entries(p).filter(([, v]) => v.length);
  expect(found.length).toBe(1);
  return { kind: found[0]![0], item: found[0]![1][0] };
};

describe("plan: one file", () => {
  const A = "a.md";
  test("same everywhere: nothing to do but remember it", () => {
    expect(only(maps({ [A]: "1" }, { [A]: "1" }, { [A]: "1" }))).toEqual({ kind: "record", item: A });
    // Never synced but identical (the first sync into a vault that already has the note).
    expect(only(maps({ [A]: "1" }, { [A]: "1" }, {}))).toEqual({ kind: "record", item: A });
    // Both sides reached the same text on their own.
    expect(only(maps({ [A]: "2" }, { [A]: "2" }, { [A]: "1" })).kind).toBe("record");
  });

  test("changed here only: push against what the server had", () => {
    expect(only(maps({ [A]: "2" }, { [A]: "1" }, { [A]: "1" }))).toEqual({ kind: "push", item: { path: A, base: "1" } });
  });

  test("changed there only: pull, and only over the copy we last saw", () => {
    expect(only(maps({ [A]: "1" }, { [A]: "2" }, { [A]: "1" }))).toEqual({ kind: "pull", item: { path: A, local: "1" } });
  });

  test("changed on both sides: keep both, never pick one", () => {
    expect(only(maps({ [A]: "2" }, { [A]: "3" }, { [A]: "1" }))).toEqual({ kind: "conflict", item: { path: A, local: "2", remote: "3" } });
  });

  test("first sync with different text on each side is a conflict, not an overwrite", () => {
    expect(only(maps({ [A]: "2" }, { [A]: "3" }, {})).kind).toBe("conflict");
  });

  test("new on one side: it goes to the other", () => {
    expect(only(maps({ [A]: "1" }, {}, {}))).toEqual({ kind: "push", item: { path: A, base: null } });
    expect(only(maps({}, { [A]: "1" }, {}))).toEqual({ kind: "pull", item: { path: A, local: null } });
  });

  test("deleted on one side and untouched on the other: the delete follows", () => {
    expect(only(maps({ [A]: "1" }, {}, { [A]: "1" }))).toEqual({ kind: "deleteLocal", item: { path: A, hash: "1" } });
    expect(only(maps({}, { [A]: "1" }, { [A]: "1" }))).toEqual({ kind: "deleteRemote", item: { path: A, hash: "1" } });
  });

  test("deleted on one side but edited on the other: the edit wins", () => {
    expect(only(maps({ [A]: "2" }, {}, { [A]: "1" }))).toEqual({ kind: "push", item: { path: A, base: null } });
    expect(only(maps({}, { [A]: "2" }, { [A]: "1" }))).toEqual({ kind: "pull", item: { path: A, local: null } });
  });

  test("gone from both: forget it", () => {
    expect(only(maps({}, {}, { [A]: "1" }))).toEqual({ kind: "forget", item: A });
  });
});

describe("plan: a vault", () => {
  test("every path lands in exactly one list", () => {
    const p = maps(
      { same: "1", mine: "2", new: "1", gone: "1", clash: "4" },
      { same: "1", mine: "1", theirs: "9", gone2: "1", clash: "5" },
      { same: "1", mine: "1", gone: "1", gone2: "1", clash: "1" },
    );
    expect(p.record).toEqual(["same"]);
    expect(p.push.map((x) => x.path).sort()).toEqual(["mine", "new"]);
    expect(p.pull.map((x) => x.path)).toEqual(["theirs"]);
    expect(p.conflict.map((x) => x.path)).toEqual(["clash"]);
    expect(p.deleteLocal.map((x) => x.path)).toEqual(["gone"]);
    expect(p.deleteRemote.map((x) => x.path)).toEqual(["gone2"]);
  });

  test("an empty side is never read as 'delete everything' without a say-so", () => {
    const synced = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`n${i}.md`, "h"]));
    const p = maps(synced, {}, synced);
    expect(p.deleteLocal.length).toBe(20);
    expect(massDeletes(p, 20)).toEqual({ local: 20, remote: 0 });
    // A few deletions, or a small share of the vault, go through.
    expect(massDeletes(maps({ a: "1" }, {}, { a: "1" }), 1)).toEqual({ local: 0, remote: 0 });
    const some = maps({ ...synced, extra: "1" }, Object.fromEntries(Object.keys(synced).slice(10).map((k) => [k, "h"])), synced);
    expect(massDeletes(some, 100)).toEqual({ local: 0, remote: 0 });
  });
});

describe("paths", () => {
  test("syncable follows the server's rules", () => {
    for (const ok of ["a.md", "Folder/Sub folder/a b.md", "attachments/photo.png", "Notes (2026).md", "ünï.md"]) expect(syncable(ok)).toBe(true);
    for (const bad of ["", ".obsidian/app.json", "a/.hidden/b.md", ".trash/x.md", "a:b.md", "what?.md", "a/ b.md", "a /b.md", "node_modules/x.md", "a/node_modules", "x".repeat(256) + ".md"])
      expect(syncable(bad)).toBe(false);
  });

  test("conflict copy names keep the folder and extension, and are never taken", () => {
    const free = () => false;
    expect(conflictPath("Notes/Plan.md", "2026-11-02", free)).toBe("Notes/Plan (conflict 2026-11-02).md");
    expect(conflictPath("Board.excalidraw.md", "2026-11-02", free)).toBe("Board (conflict 2026-11-02).excalidraw.md");
    expect(conflictPath("pics/cat.png", "2026-11-02", free)).toBe("pics/cat (conflict 2026-11-02).png");
    expect(conflictPath("README", "2026-11-02", free)).toBe("README (conflict 2026-11-02)");
    const taken = new Set(["a (conflict 2026-11-02).md", "a (conflict 2026-11-02 2).md"]);
    expect(conflictPath("a.md", "2026-11-02", (p) => taken.has(p))).toBe("a (conflict 2026-11-02 3).md");
    for (const p of ["Notes/Plan (conflict 2026-11-02).md", "Board (conflict 2026-11-02).excalidraw.md", "a (conflict 2026-11-02 3).md", "pics/cat (conflict 2026-11-02).png"]) {
      expect(isConflictCopy(p)).toBe(true);
      expect(syncable(p)).toBe(true);
    }
    expect(isConflictCopy("Plan.md")).toBe(false);
  });

  test("renames collapse into one move, and a rename back is no move", () => {
    const s = emptyState();
    trackRename(s, "a.md", "b.md");
    trackRename(s, "b.md", "c.md");
    expect(s.renames).toEqual([{ from: "a.md", to: "c.md" }]);
    trackRename(s, "c.md", "a.md");
    expect(s.renames).toEqual([]);
  });

  test("a folder rename is a rename of each synced file in it", () => {
    const s = emptyState();
    for (const p of ["Old/a.md", "Old/sub/b.md", "Older/c.md", "d.md"]) s.files[p] = { hash: "h", mtime: 1, size: 1 };
    trackFolderRename(s, "Old", "New");
    expect(s.renames).toEqual([
      { from: "Old/a.md", to: "New/a.md" },
      { from: "Old/sub/b.md", to: "New/sub/b.md" },
    ]);
  });
});

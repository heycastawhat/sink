import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AuthEnv } from "../auth";
import { now } from "../db";
import { cleanPath, isBoard, splitFrontmatter, VaultError, type Vault } from "../notes";
import { clientIp, rateLimit } from "../ratelimit";
import { attachmentResponse } from "./notes";
import type { Space } from "../users";
import { liveFor, LiveError, liveSocketResponse, type Room } from "../live";

/**
 * Share links: a note anyone with the link can read at /s/<id>, and edit too if the owner turns that on. The id is
 * 128 random bits; stopping the share deletes it. Links follow the note when it moves, and stop working while it's
 * deleted.
 */

const pathQuery = z.object({ path: z.string().min(1).max(1024) });
const shareBody = pathQuery.extend({ editable: z.boolean().optional() });
const editBody = z.object({ content: z.string(), base_hash: z.string(), name: z.string().trim().min(1).max(60) });
const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");

/** Biggest image a share link's visitor can paste in. */
const MAX_SHARE_UPLOAD = 10 * 1024 * 1024;

/** What an image really is, from its first bytes (not what the browser says): only these four go in. */
function imageType(b: Uint8Array): string | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  return null;
}

type Share = { id: string; path: string; created_at: number; editable: number; edited_by: string | null; edited_at: number | null };

const view = (s: Share) => ({ id: s.id, created_at: s.created_at, editable: !!s.editable, edited_by: s.edited_by, edited_at: s.edited_at });

/** Signed in: whether a note is shared, share it, stop sharing it. Only full-scope tokens (not assistants) change it. */
export function shareRoutes(db: Database, vault: Vault) {
  const app = new Hono<AuthEnv>();
  // A path no note could have: there's no share for it.
  const notePath = (raw: string) => {
    try {
      return cleanPath(raw, "note");
    } catch {
      return null;
    }
  };
  const byPath = (path: string) => db.query<Share, [string]>("SELECT * FROM shares WHERE path = ?").get(path);

  app.get("/notes/share", (c) => {
    const q = pathQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid query" }, 400);
    const path = notePath(q.data.path);
    if (!path) return c.json({ error: "invalid path" }, 400);
    const share = byPath(path);
    return c.json(share ? view(share) : { id: null });
  });

  app.post("/notes/share", async (c) => {
    if (c.get("scope") !== "full") return c.json({ error: "not allowed with this token" }, 403);
    const body = shareBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const path = notePath(body.data.path);
    if (!path) return c.json({ error: "invalid path" }, 400);
    if (isBoard(path)) return c.json({ error: "boards can't be shared yet" }, 400);
    try {
      await vault.read(path);
    } catch (err) {
      if (err instanceof VaultError) return c.json({ error: err.message }, err.status);
      throw err;
    }
    const existing = byPath(path);
    if (existing) {
      if (body.data.editable !== undefined) {
        db.query("UPDATE shares SET editable = ? WHERE id = ?").run(body.data.editable ? 1 : 0, existing.id);
        liveFor(vault).room(path)?.shareChanged(existing.id, body.data.editable);
      }
      return c.json(view(byPath(path)!));
    }
    db.query("INSERT INTO shares (id, path, created_at, editable) VALUES (?, ?, ?, ?)").run(random(), path, now(), body.data.editable ? 1 : 0);
    return c.json(view(byPath(path)!), 201);
  });

  app.delete("/notes/share", (c) => {
    if (c.get("scope") !== "full") return c.json({ error: "not allowed with this token" }, 403);
    const q = pathQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid query" }, 400);
    const path = notePath(q.data.path);
    if (!path) return c.json({ error: "invalid path" }, 400);
    const share = byPath(path);
    db.query("DELETE FROM shares WHERE path = ?").run(path);
    if (share) liveFor(vault).room(path)?.shareChanged(share.id, null);
    return c.json({ ok: true });
  });

  return app;
}

/**
 * Public: a shared note's text (frontmatter left out: it can hold things not meant for readers), and the images it
 * embeds, nothing else from the vault. An editable share also takes new text, which replaces the body and keeps the
 * frontmatter as it is.
 */
/** What a note embeds (![[name]] or ![](name)): all a public page may fetch besides the note itself. */
export function embedsOf(content: string): Set<string> {
  return new Set(
    [...content.matchAll(/!\[\[([^\]|#]+)[^\]]*\]\]|!\[[^\]]*\]\(<?([^)>\s]+)>?\)/g)].map((m) => {
      let ref = (m[1] ?? m[2] ?? "").trim();
      try {
        ref = decodeURIComponent(ref);
      } catch {}
      return ref.replace(/^(\.{1,2}\/)+/, "");
    }),
  );
}

/** Embeds a visitor's edit may have (lower-cased): what the note already embeds, and images pasted in through the link. */
function allowedEmbeds(db: Database, shareId: string, content: string): Set<string> {
  const names = [...embedsOf(content)].map((e) => e.toLowerCase());
  const uploads = db.query<{ name: string }, [string]>("SELECT name FROM share_uploads WHERE share_id = ?").all(shareId).map((r) => r.name);
  return new Set([...names, ...uploads]);
}

export function publicShareRoutes(spaces: () => Space[]) {
  const app = new Hono();
  const allowed = rateLimit(120, 60_000);
  app.use("/share/*", async (c, next) => {
    if (!allowed(clientIp(c))) return c.json({ error: "slow down" }, 429);
    await next();
    c.header("x-robots-tag", "noindex, nofollow");
    c.header("cache-control", "no-store");
  });

  // Share ids are random across all accounts, so whichever account has it is the one it belongs to.
  const find = (id: string) => {
    for (const space of spaces()) {
      const share = space.db.query<Share, [string]>("SELECT * FROM shares WHERE id = ?").get(id);
      if (share) return { ...space, share };
    }
    return null;
  };
  const shared = async (id: string) => {
    const found = find(id);
    if (!found) return null;
    try {
      return { ...found, note: await found.vault.read(found.share.path) };
    } catch (err) {
      if (err instanceof VaultError) return null;
      throw err;
    }
  };

  app.get("/share/:id", async (c) => {
    const found = await shared(c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    const { note } = found;
    const editable = !!found.share.editable;
    return c.json({ title: note.title, content: splitFrontmatter(note.content).body, mtime: note.mtime, editable, hash: editable ? note.hash : undefined });
  });

  app.put("/share/:id", async (c) => {
    const found = await shared(c.req.param("id"));
    if (!found?.share.editable) return c.json({ error: "not found" }, 404);
    const { db, vault, note, share } = found;
    const body = editBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const { body: text } = splitFrontmatter(note.content);
    // A closing `---` with no newline after it would join the visitor's first line onto it.
    let frontmatter = note.content.slice(0, note.content.length - text.length);
    if (frontmatter && !frontmatter.endsWith("\n")) frontmatter += "\n";
    // Text that reads as frontmatter would set the note's properties (`publish: true`, say).
    if (splitFrontmatter(frontmatter + body.data.content).yaml !== splitFrontmatter(note.content).yaml) return c.json({ error: "the text can't change the note's properties" }, 400);
    // The attachment route serves what the note embeds, so a visitor adding an embed could fetch any file in the vault.
    const embeds = allowedEmbeds(db, share.id, note.content);
    if ([...embedsOf(body.data.content)].some((e) => !embeds.has(e.toLowerCase()))) return c.json({ error: "images can't be added to a shared note" }, 400);
    try {
      // Someone new editing keeps what was there as a version, so the owner can undo a visitor's changes.
      const keepVersion = share.edited_by !== body.data.name;
      const saved = await vault.write(share.path, frontmatter + body.data.content, body.data.base_hash, { keepVersion });
      db.query("UPDATE shares SET edited_by = ?, edited_at = ? WHERE id = ?").run(body.data.name, now(), share.id);
      return c.json({ hash: saved.hash, mtime: saved.mtime });
    } catch (err) {
      if (!(err instanceof VaultError)) throw err;
      // The current text, without its frontmatter, so the editor can catch up.
      const current = err.current && "content" in err.current && { content: splitFrontmatter(err.current.content).body, hash: err.current.hash };
      return c.json({ error: err.message, current }, err.status);
    }
  });

  /** What a share link's visitor may not do, checked on each live change as on PUT. */
  const allowFor = (db: Database, shareId: string) => (before: string, after: string) => {
    if (splitFrontmatter(after).yaml !== splitFrontmatter(before).yaml) return "the text can't change the note's properties";
    const embeds = allowedEmbeds(db, shareId, before);
    if ([...embedsOf(after)].some((e) => !embeds.has(e.toLowerCase()))) return "only images pasted here can be added to a shared note";
    return null;
  };

  // An editable link's visitor pasting or dropping an image: it goes in attachments/ under a name nobody else's file
  // has, and becomes an embed their edits may add. Images only (checked by their bytes), and not too many.
  const allowedUploads = rateLimit(30, 60 * 60_000);
  app.post("/share/:id/attachment", async (c) => {
    const id = c.req.param("id");
    const found = find(id);
    if (!found?.share.editable) return c.json({ error: "not found" }, 404);
    if (!allowedUploads(clientIp(c))) return c.json({ error: "too many images, try again later" }, 429);
    if (Number(c.req.header("content-length") ?? 0) > MAX_SHARE_UPLOAD + 64 * 1024) return c.json({ error: "too large" }, 413);
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "need a file" }, 400);
    if (file.size > MAX_SHARE_UPLOAD) return c.json({ error: "images up to 10 MB" }, 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = imageType(bytes);
    if (!type) return c.json({ error: "only images (PNG, JPEG, GIF, WebP) can be added" }, 400);
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    try {
      const path = await found.vault.saveAttachment(`Pasted image ${stamp} ${random().slice(0, 6)}.${type}`, bytes);
      const name = path.split("/").pop()!;
      found.db.query("INSERT OR IGNORE INTO share_uploads (share_id, name, created_at) VALUES (?, ?, ?)").run(id, name.toLowerCase(), now());
      return c.json({ embed: `![[${name}]]` }, 201);
    } catch (err) {
      if (err instanceof VaultError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  // Live: everyone on the link sees changes as they're made. A visitor who gave a name can edit, if the link allows it.
  app.get("/share/:id/live", async (c) => {
    const id = c.req.param("id");
    const found = find(id);
    if (!found) return c.json({ error: "not found" }, 404);
    let room: Room;
    try {
      room = await liveFor(found.vault).open(found.share.path);
    } catch (err) {
      if (err instanceof LiveError || err instanceof VaultError) return c.json({ error: "not found" }, 404);
      throw err;
    }
    const name = (c.req.query("name") ?? "").trim().slice(0, 60);
    let recorded = 0;
    return liveSocketResponse(c, room, {
      principal: `share:${id}:${name}`,
      name: name || "Viewer",
      view: "body",
      editor: !!found.share.editable && !!name,
      allow: allowFor(found.db, id),
      shareId: id,
      // Who edited last, for the owner's share dialog (as a PUT records it), at most once a minute.
      onEdit: () => {
        if (now() - recorded < 60_000) return;
        recorded = now();
        found.db.query("UPDATE shares SET edited_by = ?, edited_at = ? WHERE id = ?").run(name, recorded, id);
      },
    });
  });

  app.get("/share/:id/attachment", async (c) => {
    const found = await shared(c.req.param("id"));
    const name = c.req.query("name") ?? "";
    // Only what this note embeds, so a share can't be used to fetch the rest of the vault.
    // Or one pasted in through the link, which a live edit can show before the room has written the note.
    if (!found || !name || !allowedEmbeds(found.db, found.share.id, found.note.content).has(name.toLowerCase())) return c.json({ error: "not found" }, 404);
    const path = found.vault.resolveFile(name);
    if (!path) return c.json({ error: "not found" }, 404);
    return attachmentResponse(found.vault, path);
  });

  return app;
}

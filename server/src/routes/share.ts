import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AuthEnv } from "../auth";
import { now } from "../db";
import { cleanPath, isBoard, splitFrontmatter, VaultError, type Vault } from "../notes";
import { clientIp, rateLimit } from "../ratelimit";
import { attachmentResponse } from "./notes";
import type { Space } from "../users";

/**
 * Share links: a note anyone with the link can read at /s/<id>, and edit too if the owner turns that on. The id is
 * 128 random bits; stopping the share deletes it. Links follow the note when it moves, and stop working while it's
 * deleted.
 */

const pathQuery = z.object({ path: z.string().min(1).max(1024) });
const shareBody = pathQuery.extend({ editable: z.boolean().optional() });
const editBody = z.object({ content: z.string(), base_hash: z.string(), name: z.string().trim().min(1).max(60) });
const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");

type Share = { id: string; path: string; created_at: number; editable: number; edited_by: string | null; edited_at: number | null };

const view = (s: Share) => ({ id: s.id, created_at: s.created_at, editable: !!s.editable, edited_by: s.edited_by, edited_at: s.edited_at });

/** Signed in: whether a note is shared, share it, stop sharing it. Only full-scope tokens (not assistants) change it. */
export function shareRoutes(db: Database, vault: Vault) {
  const app = new Hono<AuthEnv>();
  const byPath = (path: string) => db.query<Share, [string]>("SELECT * FROM shares WHERE path = ?").get(path);

  app.get("/notes/share", (c) => {
    const q = pathQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid query" }, 400);
    const share = byPath(cleanPath(q.data.path, "note"));
    return c.json(share ? view(share) : { id: null });
  });

  app.post("/notes/share", async (c) => {
    if (c.get("scope") !== "full") return c.json({ error: "not allowed with this token" }, 403);
    const body = shareBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const path = cleanPath(body.data.path, "note");
    if (isBoard(path)) return c.json({ error: "boards can't be shared yet" }, 400);
    try {
      await vault.read(path);
    } catch (err) {
      if (err instanceof VaultError) return c.json({ error: err.message }, err.status);
      throw err;
    }
    const existing = byPath(path);
    if (existing) {
      if (body.data.editable !== undefined) db.query("UPDATE shares SET editable = ? WHERE id = ?").run(body.data.editable ? 1 : 0, existing.id);
      return c.json(view(byPath(path)!));
    }
    db.query("INSERT INTO shares (id, path, created_at, editable) VALUES (?, ?, ?, ?)").run(random(), path, now(), body.data.editable ? 1 : 0);
    return c.json(view(byPath(path)!), 201);
  });

  app.delete("/notes/share", (c) => {
    if (c.get("scope") !== "full") return c.json({ error: "not allowed with this token" }, 403);
    const q = pathQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid query" }, 400);
    db.query("DELETE FROM shares WHERE path = ?").run(cleanPath(q.data.path, "note"));
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
    const embeds = embedsOf(note.content);
    if ([...embedsOf(body.data.content)].some((e) => !embeds.has(e))) return c.json({ error: "images can't be added to a shared note" }, 400);
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

  app.get("/share/:id/attachment", async (c) => {
    const found = await shared(c.req.param("id"));
    const name = c.req.query("name") ?? "";
    // Only what this note embeds, so a share can't be used to fetch the rest of the vault.
    if (!found || !name || !embedsOf(found.note.content).has(name)) return c.json({ error: "not found" }, 404);
    const path = found.vault.resolveFile(name);
    if (!path) return c.json({ error: "not found" }, 404);
    return attachmentResponse(found.vault, path);
  });

  return app;
}

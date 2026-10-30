import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AuthEnv } from "../auth";
import { now } from "../db";
import { cleanPath, isBoard, splitFrontmatter, VaultError, type Vault } from "../notes";
import { clientIp, rateLimit } from "../ratelimit";
import { attachmentResponse } from "./notes";

/**
 * Share links: a note anyone with the link can read (not edit), at /s/<id>. The id is 128 random bits; stopping
 * the share deletes it. Links follow the note when it moves, and stop working while it's deleted.
 */

const pathQuery = z.object({ path: z.string().min(1).max(1024) });
const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");

type Share = { id: string; path: string; created_at: number };

/** Signed in: whether a note is shared, share it, stop sharing it. Only full-scope tokens (not assistants) change it. */
export function shareRoutes(db: Database, vault: Vault) {
  const app = new Hono<AuthEnv>();
  const byPath = (path: string) => db.query<Share, [string]>("SELECT * FROM shares WHERE path = ?").get(path);

  app.get("/notes/share", (c) => {
    const q = pathQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid query" }, 400);
    const share = byPath(cleanPath(q.data.path, "note"));
    return c.json({ id: share?.id ?? null, created_at: share?.created_at ?? null });
  });

  app.post("/notes/share", async (c) => {
    if (c.get("scope") !== "full") return c.json({ error: "not allowed with this token" }, 403);
    const body = pathQuery.safeParse(await c.req.json().catch(() => null));
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
    if (existing) return c.json({ id: existing.id, created_at: existing.created_at });
    const share = { id: random(), path, created_at: now() };
    db.query("INSERT INTO shares (id, path, created_at) VALUES (?, ?, ?)").run(share.id, share.path, share.created_at);
    return c.json({ id: share.id, created_at: share.created_at }, 201);
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
 * embeds, nothing else from the vault.
 */
export function publicShareRoutes(db: Database, vault: Vault) {
  const app = new Hono();
  const allowed = rateLimit(120, 60_000);
  app.use("*", async (c, next) => {
    if (!allowed(clientIp(c))) return c.json({ error: "slow down" }, 429);
    await next();
    c.header("x-robots-tag", "noindex, nofollow");
    c.header("cache-control", "no-store");
  });

  const shared = async (id: string) => {
    const share = db.query<Share, [string]>("SELECT * FROM shares WHERE id = ?").get(id);
    if (!share) return null;
    try {
      return await vault.read(share.path);
    } catch (err) {
      if (err instanceof VaultError) return null;
      throw err;
    }
  };

  app.get("/share/:id", async (c) => {
    const note = await shared(c.req.param("id"));
    if (!note) return c.json({ error: "not found" }, 404);
    return c.json({ title: note.title, content: splitFrontmatter(note.content).body, mtime: note.mtime });
  });

  app.get("/share/:id/attachment", async (c) => {
    const note = await shared(c.req.param("id"));
    const name = c.req.query("name") ?? "";
    // Only what this note embeds (![[name]] or ![](name)), so a share can't be used to fetch the rest of the vault.
    const embeds = new Set(
      [...note?.content.matchAll(/!\[\[([^\]|#]+)[^\]]*\]\]|!\[[^\]]*\]\(<?([^)>\s]+)>?\)/g) ?? []].map((m) => {
        let ref = (m[1] ?? m[2] ?? "").trim();
        try {
          ref = decodeURIComponent(ref);
        } catch {}
        return ref.replace(/^(\.{1,2}\/)+/, "");
      }),
    );
    if (!note || !name || !embeds.has(name)) return c.json({ error: "not found" }, 404);
    const path = vault.resolveFile(name);
    if (!path) return c.json({ error: "not found" }, 404);
    return attachmentResponse(vault, path);
  });

  return app;
}

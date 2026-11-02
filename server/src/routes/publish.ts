import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../auth";
import { cleanPath, splitFrontmatter, VaultError } from "../notes";
import { clientIp, rateLimit } from "../ratelimit";
import type { Users } from "../users";
import { attachmentResponse } from "./notes";
import { embedsOf } from "./share";

// Lower-case letters, digits and dashes, so it reads well in a URL.
const handleBody = z.object({ handle: z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/).nullable() });

/** Signed in: the account's public page name. */
export function publishRoutes(users: Users) {
  const app = new Hono<AuthEnv>();
  app.get("/publish", (c) => c.json({ handle: users.handleOf(c.get("subject")) }));
  app.put("/publish", async (c) => {
    if (c.get("scope") !== "full") return c.json({ error: "not allowed with this token" }, 403);
    const body = handleBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "use lower-case letters, numbers and dashes" }, 400);
    // "owner" is the route the bare /public page asks, so no account can have it.
    if (body.data.handle === "owner" || !users.setHandle(c.get("subject"), body.data.handle)) return c.json({ error: "someone else has that name" }, 409);
    return c.json({ handle: body.data.handle });
  });
  return app;
}

/**
 * What search engines may do with a /public/… page. Only a published note marked `searchable: true` is indexed; the
 * list is never indexed itself, but they may follow it to the notes that are.
 */
export async function robotsFor(users: Users, pathname: string): Promise<string | null> {
  const [handle, ...rest] = pathname.split("/").slice(2).filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return "";
    }
  });
  if (!rest.length) return "noindex, follow";
  const space = handle ? users.byHandle(handle) : null;
  const note = await Promise.resolve()
    .then(() => space?.vault.read(cleanPath(`${rest.join("/")}.md`, "note")))
    .catch(() => null);
  return note?.publish && note.searchable ? null : "noindex, nofollow";
}

/**
 * Public: each account's published notes (`publish: true`) under /api/public/pages/<handle>. Like share links, only
 * the notes' text (no frontmatter) and the images they embed; nothing about unpublished notes, not even their names.
 */
export function publicPageRoutes(users: Users) {
  const app = new Hono();
  const allowed = rateLimit(240, 60_000);
  app.use("*", async (c, next) => {
    if (!allowed(clientIp(c))) return c.json({ error: "slow down" }, 429);
    await next();
    c.header("cache-control", "no-store");
    c.header("x-robots-tag", "noindex");
  });

  const published = async (handle: string, raw: string) => {
    const space = users.byHandle(handle);
    if (!space) return null;
    try {
      const note = await space.vault.read(cleanPath(raw, "note"));
      return note.publish ? { space, note } : null;
    } catch (err) {
      if (err instanceof VaultError) return null;
      throw err;
    }
  };

  // The bare /public page: the owner's.
  app.get("/owner", (c) => c.json({ handle: users.ownerHandle() }));

  app.get("/:handle", (c) => {
    const space = users.byHandle(c.req.param("handle"));
    if (!space) return c.json({ error: "not found" }, 404);
    const notes = space.vault
      .list()
      .notes.filter((n) => n.publish)
      .map(({ path, title, mtime, excerpt, tags }) => ({ path, title, mtime, excerpt, tags }));
    return c.json({ handle: c.req.param("handle"), notes });
  });

  app.get("/:handle/note", async (c) => {
    const found = await published(c.req.param("handle"), c.req.query("path") ?? "");
    if (!found) return c.json({ error: "not found" }, 404);
    const { note } = found;
    return c.json({ path: note.path, title: note.title, content: splitFrontmatter(note.content).body, mtime: note.mtime });
  });

  app.get("/:handle/attachment", async (c) => {
    const found = await published(c.req.param("handle"), c.req.query("path") ?? "");
    const name = c.req.query("name") ?? "";
    if (!found || !name || !embedsOf(found.note.content).has(name)) return c.json({ error: "not found" }, 404);
    const path = found.space.vault.resolveFile(name);
    return path ? attachmentResponse(found.space.vault, path) : c.json({ error: "not found" }, 404);
  });

  return app;
}

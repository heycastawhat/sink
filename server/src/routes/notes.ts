import type { Context } from "hono";
import { Hono } from "hono";
import { extname } from "node:path";
import { z } from "zod";
import type { AuthEnv } from "../auth";
import { cleanPath, COLORS, toFtsQuery, VaultError, type Vault } from "../notes";

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

const pathQuery = z.object({ path: z.string().min(1).max(1024) });
// keep_version: always keep the text being replaced as a version (restoring an old one shouldn't lose the current).
const saveBody = z.object({ content: z.string(), base_hash: z.string().max(64).nullable(), keep_version: z.boolean().optional() });
const createBody = z.object({
  folder: z.string().max(1024).default(""),
  title: z.string().trim().max(200).default(""),
  content: z.string().default(""),
});
const moveBody = z.object({ from: z.string().min(1).max(1024), to: z.string().min(1).max(1024) });
const listQuery = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});

export function noteRoutes(vault: Vault, maxUploadBytes: number, trashDays = 0) {
  const app = new Hono<AuthEnv>();

  /** Vault errors become their status; the 409 on a stale save carries the file as it is now. */
  const run = async (c: Context<AuthEnv>, fn: () => Promise<Response>) => {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof VaultError)) throw err;
      return c.json({ error: err.message, ...(err.current && { current: err.current }) }, err.status);
    }
  };

  app.get("/notes", (c) => {
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid query" }, 400);
    const { q, limit } = parsed.data;
    if (!q?.trim()) return c.json(vault.list());
    const fts = toFtsQuery(q);
    return c.json({ items: fts ? vault.search(fts, limit) : [] });
  });

  app.post("/notes/scan", (c) => run(c, async () => c.json(await vault.scan())));

  app.get("/notes/file", (c) =>
    run(c, async () => {
      const q = pathQuery.safeParse(c.req.query());
      if (!q.success) return c.json({ error: "invalid query" }, 400);
      return c.json(await vault.read(q.data.path));
    }),
  );

  // Version history: the list, and one version's text. Restoring is a normal save of that text.
  app.get("/notes/versions", (c) =>
    run(c, async () => {
      const q = pathQuery.safeParse(c.req.query());
      if (!q.success) return c.json({ error: "invalid query" }, 400);
      return c.json({ items: vault.versions(q.data.path) });
    }),
  );

  app.get("/notes/versions/:id", (c) =>
    run(c, async () => {
      const q = pathQuery.safeParse(c.req.query());
      const id = Number(c.req.param("id"));
      if (!q.success || !Number.isInteger(id)) return c.json({ error: "invalid request" }, 400);
      return c.json(vault.version(q.data.path, id));
    }),
  );

  // Notes that link to this one.
  app.get("/notes/backlinks", (c) =>
    run(c, async () => {
      const q = pathQuery.safeParse(c.req.query());
      if (!q.success) return c.json({ error: "invalid query" }, 400);
      return c.json({ items: vault.backlinks(q.data.path) });
    }),
  );

  app.put("/notes/file", (c) =>
    run(c, async () => {
      const q = pathQuery.safeParse(c.req.query());
      const body = saveBody.safeParse(await c.req.json().catch(() => null));
      if (!q.success || !body.success) return c.json({ error: "invalid request" }, 400);
      return c.json(await vault.write(q.data.path, body.data.content, body.data.base_hash, { keepVersion: body.data.keep_version }));
    }),
  );

  // Keep-style pin and colour; stored as frontmatter so the file stays the truth.
  app.patch("/notes/meta", (c) =>
    run(c, async () => {
      const q = pathQuery.safeParse(c.req.query());
      const body = z
        .object({ pinned: z.boolean().optional(), color: z.enum(COLORS as [string, ...string[]]).nullable().optional() })
        .safeParse(await c.req.json().catch(() => null));
      if (!q.success || !body.success) return c.json({ error: "invalid request" }, 400);
      return c.json(await vault.setMeta(q.data.path, body.data));
    }),
  );

  app.post("/notes", (c) =>
    run(c, async () => {
      const body = createBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "invalid body" }, 400);
      const { folder, title, content } = body.data;
      return c.json(await vault.create(folder, title, content), 201);
    }),
  );

  app.post("/notes/move", (c) =>
    run(c, async () => {
      const body = moveBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "invalid body" }, 400);
      await vault.move(body.data.from, body.data.to);
      return c.json({ ok: true, path: cleanPath(body.data.to, body.data.to.toLowerCase().endsWith(".md") ? "note" : "folder") });
    }),
  );

  // Notes and folders alike go to .trash/.
  app.delete("/notes/file", (c) =>
    run(c, async () => {
      const q = pathQuery.safeParse(c.req.query());
      if (!q.success) return c.json({ error: "invalid query" }, 400);
      return c.json({ ok: true, ...(await vault.trash(q.data.path)) });
    }),
  );

  // The trash: list it, put a note back, delete one for good, or empty it.
  // `days`: how long Sink keeps what it trashed (0: until emptied).
  app.get("/notes/trash", (c) => run(c, async () => c.json({ items: await vault.listTrash(), days: Math.max(0, trashDays) })));

  app.post("/notes/trash/restore", (c) =>
    run(c, async () => {
      const body = pathQuery.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "invalid body" }, 400);
      // A folder comes back whole; a note on its own.
      const path = body.data.path;
      if (!path.toLowerCase().endsWith(".md")) return c.json(await vault.restoreFolder(path));
      return c.json(await vault.restore(path));
    }),
  );

  // Gone for good, so not for AI assistants' tokens: they can trash and restore, but only you empty the trash.
  app.delete("/notes/trash", (c) =>
    run(c, async () => {
      if (c.get("scope") !== "full") return c.json({ error: "not allowed with this token" }, 403);
      if (c.req.query("all") === "true") await vault.emptyTrash();
      else {
        const q = pathQuery.safeParse(c.req.query());
        if (!q.success) return c.json({ error: "invalid query" }, 400);
        await vault.deleteForever(q.data.path);
      }
      return c.json({ ok: true });
    }),
  );

  app.post("/notes/folders", (c) =>
    run(c, async () => {
      const body = pathQuery.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "invalid body" }, 400);
      return c.json({ path: await vault.createFolder(body.data.path) }, 201);
    }),
  );

  // Images and files notes point at, by vault path or by the bare name a `![[embed]]` uses.
  app.get("/notes/attachment", (c) =>
    run(c, async () => {
      const ref = c.req.query("path") ?? c.req.query("name");
      const path = ref ? vault.resolveFile(ref) : null;
      if (!path) return c.json({ error: "not found" }, 404);
      const bytes = await vault.readFile(path);
      const type = TYPES[extname(path).toLowerCase()];
      return new Response(bytes, {
        headers: {
          "content-type": type ?? "application/octet-stream",
          // Same origin as the app, so nothing in the vault may run script here (an .svg or .html could).
          "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
          "x-content-type-options": "nosniff",
          "cache-control": "private, max-age=300",
          ...(!type && { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.split("/").pop()!)}` }),
        },
      });
    }),
  );

  app.post("/notes/attachments", (c) =>
    run(c, async () => {
      if (Number(c.req.header("content-length") ?? 0) > maxUploadBytes) return c.json({ error: "too large" }, 413);
      const form = await c.req.formData().catch(() => null);
      const file = form?.get("file");
      if (!(file instanceof File)) return c.json({ error: "need a file" }, 400);
      if (file.size > maxUploadBytes) return c.json({ error: "too large" }, 413);
      const path = await vault.saveAttachment(file.name || "file", new Uint8Array(await file.arrayBuffer()));
      return c.json({ path, embed: `![[${path.split("/").pop()}]]` }, 201);
    }),
  );

  return app;
}

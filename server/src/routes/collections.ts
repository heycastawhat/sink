import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../auth";
import { newId, now } from "../db";

type CollectionRow = { id: string; name: string; created_at: number; count: number; cover_id: string | null };

const nameBody = z.object({ name: z.string().trim().min(1).max(60) });

// Boards the user files captures into. Membership itself is set on the capture (PATCH {collections}).
export function collectionRoutes(db: Database) {
  const app = new Hono<AuthEnv>();

  // Counts and covers skip trashed captures, same as browsing does.
  const list = () =>
    db
      .query<CollectionRow, []>(
        `SELECT col.id, col.name, col.created_at,
           (SELECT COUNT(*) FROM capture_collections cc JOIN captures c ON c.id = cc.capture_id
            WHERE cc.collection_id = col.id AND c.deleted_at IS NULL) AS count,
           (SELECT c.id FROM capture_collections cc JOIN captures c ON c.id = cc.capture_id
            WHERE cc.collection_id = col.id AND c.deleted_at IS NULL ORDER BY c.created_at DESC LIMIT 1) AS cover_id
         FROM collections col ORDER BY col.name COLLATE NOCASE`,
      )
      .all()
      .map(serialize);

  const serialize = ({ cover_id, ...row }: CollectionRow) => ({
    ...row,
    cover_url: cover_id ? `/api/media/${cover_id}/thumb` : null,
  });

  const taken = (name: string, except = "") =>
    db
      .query<{ id: string }, [string, string]>("SELECT id FROM collections WHERE name = ? COLLATE NOCASE AND id != ?")
      .get(name, except) !== null;

  app.get("/collections", (c) => c.json({ collections: list() }));

  app.post("/collections", async (c) => {
    const parsed = nameBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    const { name } = parsed.data;
    if (taken(name)) return c.json({ error: "name taken" }, 409);
    const id = newId();
    db.query("INSERT INTO collections (id, name, created_at) VALUES (?, ?, ?)").run(id, name, now());
    return c.json(list().find((col) => col.id === id), 201);
  });

  app.patch("/collections/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = nameBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    if (taken(parsed.data.name, id)) return c.json({ error: "name taken" }, 409);
    const result = db.query("UPDATE collections SET name = ? WHERE id = ?").run(parsed.data.name, id);
    if (result.changes === 0) return c.json({ error: "not found" }, 404);
    return c.json(list().find((col) => col.id === id));
  });

  // Captures stay; only the board and its memberships go.
  app.delete("/collections/:id", (c) => {
    const result = db.query("DELETE FROM collections WHERE id = ?").run(c.req.param("id"));
    if (result.changes === 0) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}

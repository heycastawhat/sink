import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../auth";
import { MediaError, type MediaStore } from "../media";
import { enqueue } from "../worker";
import { newId, now } from "../db";
import { KINDS } from "../ai/extract";
import { fuse, type VectorIndex } from "../semantic";
import { watchUrl, type PriceWatch } from "../prices";

type CaptureRow = Record<string, unknown> & {
  id: string;
  tags: string;
  entities: string;
  image_path: string | null;
  thumb_path: string | null;
  pinned: number;
};
type ActionRow = Record<string, unknown> & { payload: string };

const PAGE_SIZE = 40;
const COLUMNS = `c.id, c.created_at, c.updated_at, c.source, c.app_package, c.image_path, c.thumb_path,
  c.mime, c.width, c.height, c.note_text, c.ocr_text, c.status, c.error, c.kind, c.title, c.summary,
  c.tags, c.entities, c.model, c.pinned, c.reviewed_at, c.archived_at, c.deleted_at, c.source_url`;

function serialize(row: CaptureRow, actions?: ActionRow[], collections?: string[], priceWatch?: object | null) {
  const { image_path, thumb_path, ...rest } = row;
  return {
    ...rest,
    pinned: row.pinned === 1,
    tags: JSON.parse(row.tags) as string[],
    entities: JSON.parse(row.entities) as Record<string, string[]>,
    // Notes and links saved by assistants have no screenshot.
    image_url: image_path ? `/api/media/${row.id}/original` : null,
    thumb_url: thumb_path ? `/api/media/${row.id}/thumb` : null,
    ...(actions && { actions: actions.map((a) => ({ ...a, payload: JSON.parse(a.payload) })) }),
    ...(collections && { collections }),
    ...(priceWatch !== undefined && { price_watch: priceWatch }),
  };
}

/** Screen text is exact but misses text inside images; OCR catches those. Keep both, screen text first. */
export function mergeText(screenText?: string, ocrText?: string): string | null {
  const screen = screenText?.trim();
  const ocr = ocrText?.trim();
  if (screen && ocr) return `${screen}\n\n--- OCR ---\n${ocr}`;
  return screen || ocr || null;
}

/** Turns free text into a safe FTS5 query: every word becomes a quoted prefix term. */
export function toFtsQuery(q: string): string | null {
  const words = q.match(/[\p{L}\p{N}]+/gu);
  if (!words?.length) return null;
  return words.map((w) => `"${w}"*`).join(" ");
}

const listQuery = z.object({
  q: z.string().max(200).optional(),
  kind: z.enum(KINDS).optional(),
  tag: z.string().max(60).optional(),
  collection: z.string().max(60).optional(),
  view: z.enum(["all", "pinned", "archived", "trash"]).default("all"),
  cursor: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(PAGE_SIZE),
});

const patchBody = z
  .object({
    title: z.string().max(200),
    note_text: z.string().max(4000).nullable(),
    tags: z.array(z.string().max(40)).max(20),
    kind: z.enum(KINDS),
    pinned: z.boolean(),
    reviewed: z.boolean(),
    archived: z.boolean(),
    deleted: z.boolean(),
    // Full membership: collection ids the capture belongs to after the patch.
    collections: z.array(z.string().max(60)).max(100),
    watch_price: z.boolean(),
  })
  .partial();

const uploadFields = z.object({
  note: z.string().max(4000).optional(),
  ocr_text: z.string().max(50_000).optional(),
  source: z.enum(["share", "auto", "tile", "assist", "web", "mcp"]).default("web"),
  // A note's body when there's no screenshot (or extra text alongside one).
  text: z.string().max(50_000).optional(),
  // From the assistant: the real text on screen (better than OCR) and the page URL.
  screen_text: z.string().max(50_000).optional(),
  source_url: z.string().url().max(2000).optional(),
  app_package: z.string().max(200).optional(),
  client_id: z.string().max(100).optional(),
  captured_at: z.coerce.number().int().positive().optional(),
});

export function captureRoutes(db: Database, media: MediaStore, maxUploadBytes: number, index?: VectorIndex) {
  const app = new Hono<AuthEnv>();

  const getCapture = (id: string) =>
    db.query<CaptureRow, [string]>(`SELECT ${COLUMNS} FROM captures c WHERE c.id = ?`).get(id);
  const getActions = (id: string) =>
    db
      .query<ActionRow, [string]>("SELECT * FROM actions WHERE capture_id = ? ORDER BY created_at")
      .all(id);
  const getCollections = (id: string) =>
    db
      .query<{ collection_id: string }, [string]>("SELECT collection_id FROM capture_collections WHERE capture_id = ?")
      .all(id)
      .map((r) => r.collection_id);
  const getPriceWatch = (id: string) => {
    const w = db.query<PriceWatch, [string]>("SELECT * FROM price_watches WHERE capture_id = ?").get(id);
    if (!w) return null;
    const history = db
      .query<{ at: number; price: number }, [string]>("SELECT at, price FROM price_points WHERE capture_id = ? ORDER BY at DESC LIMIT 60")
      .all(id)
      .reverse();
    return { ...w, history };
  };
  // Detail view: capture with its actions, collection ids and price watch.
  const full = (id: string) => serialize(getCapture(id)!, getActions(id), getCollections(id), getPriceWatch(id));

  app.post("/captures", async (c) => {
    const length = Number(c.req.header("content-length") ?? 0);
    if (length > maxUploadBytes) return c.json({ error: "file too large" }, 413);

    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ error: "expected multipart form" }, 400);
    const image = form.get("image");
    if (image !== null && !(image instanceof File)) return c.json({ error: "image must be a file" }, 400);
    if (image && image.size > maxUploadBytes) return c.json({ error: "file too large" }, 413);

    const fields = uploadFields.safeParse(
      Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string")),
    );
    if (!fields.success) return c.json({ error: "invalid fields", issues: fields.error.issues }, 400);
    const f = fields.data;
    const body = f.text?.trim();
    if (!image && !body && !f.source_url) return c.json({ error: "need an image, text or source_url" }, 400);

    // Idempotent retries from the Android upload queue.
    if (f.client_id) {
      const existing = db
        .query<{ id: string }, [string]>("SELECT id FROM captures WHERE client_id = ?")
        .get(f.client_id);
      if (existing) return c.json(full(existing.id), 200);
    }

    // Without a screenshot, the same text and link count as the same capture.
    const bytes = image ? new Uint8Array(await image.arrayBuffer()) : null;
    const sha256 = new Bun.CryptoHasher("sha256")
      .update(bytes ?? `text\n${body ?? ""}\n${f.source_url ?? ""}`)
      .digest("hex");
    const duplicate = db
      .query<{ id: string; note_text: string | null }, [string]>(
        "SELECT id, note_text FROM captures WHERE sha256 = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1",
      )
      .get(sha256);
    if (duplicate) {
      const note = f.note?.trim();
      if (note && note !== duplicate.note_text) {
        const merged = duplicate.note_text ? `${duplicate.note_text}\n${note}` : note;
        db.query("UPDATE captures SET note_text = ?, updated_at = ? WHERE id = ?").run(merged, now(), duplicate.id);
        // The note changes what the AI should make of it.
        enqueue(db, duplicate.id);
      }
      return c.json(full(duplicate.id), 200);
    }

    const id = newId();
    let stored = null;
    if (bytes) {
      try {
        stored = await media.save(id, bytes);
      } catch (err) {
        if (err instanceof MediaError) return c.json({ error: err.message }, 415);
        if ((err as Error).message?.includes("unsupported image format")) return c.json({ error: "unsupported image" }, 415);
        throw err;
      }
    }

    const createdAt = f.captured_at ?? now();
    db.transaction(() => {
      db.query(
        `INSERT INTO captures (id, created_at, updated_at, client_id, source, app_package, image_path,
           thumb_path, mime, width, height, note_text, ocr_text, sha256, source_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        createdAt,
        now(),
        f.client_id ?? null,
        f.source,
        f.app_package ?? null,
        stored?.imagePath ?? null,
        stored?.thumbPath ?? null,
        stored?.mime ?? null,
        stored?.width ?? null,
        stored?.height ?? null,
        f.note?.trim() || null,
        mergeText([body, f.screen_text?.trim()].filter(Boolean).join("\n\n"), f.ocr_text),
        sha256,
        f.source_url ?? null,
      );
      enqueue(db, id);
    })();

    return c.json(serialize(getCapture(id)!, [], []), 201);
  });

  app.get("/captures", async (c) => {
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid query" }, 400);
    const { q, kind, tag, collection, view, cursor, limit } = parsed.data;

    // Filters shared by browsing and both halves of search.
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (view === "trash") where.push("c.deleted_at IS NOT NULL");
    else {
      where.push("c.deleted_at IS NULL");
      if (view === "archived") where.push("c.archived_at IS NOT NULL");
      else where.push("c.archived_at IS NULL");
      if (view === "pinned") where.push("c.pinned = 1");
    }
    if (kind) {
      where.push("c.kind = ?");
      params.push(kind);
    }
    if (tag) {
      where.push("EXISTS (SELECT 1 FROM json_each(c.tags) WHERE value = ?)");
      params.push(tag.toLowerCase());
    }
    if (collection) {
      where.push("EXISTS (SELECT 1 FROM capture_collections cc WHERE cc.capture_id = c.id AND cc.collection_id = ?)");
      params.push(collection);
    }

    if (q?.trim()) return c.json(await search(q, where, params, Number(cursor) || 0, limit));

    // Browsing: newest first, keyset paging.
    if (cursor) {
      const [ts, id] = cursor.split("_");
      where.push("(c.created_at < ? OR (c.created_at = ? AND c.id < ?))");
      params.push(Number(ts), Number(ts), id ?? "");
    }
    const rows = db
      .query<CaptureRow, (string | number)[]>(
        `SELECT ${COLUMNS} FROM captures c WHERE ${where.join(" AND ")} ORDER BY c.created_at DESC, c.id DESC LIMIT ?`,
      )
      .all(...params, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const next = rows.length > limit && last ? `${last.created_at}_${last.id}` : null;
    return c.json({ items: page.map((r) => serialize(r)), next_cursor: next });
  });

  /**
   * Hybrid search: exact words (FTS5, bm25) fused with meaning (embeddings) by reciprocal rank.
   * "wifi password from the airbnb" finds a screenshot that only says "Network: … Key: …".
   */
  async function search(q: string, where: string[], params: (string | number)[], offset: number, limit: number) {
    const MAX = 200;
    const fts = toFtsQuery(q);
    const keywordIds = fts
      ? db
          .query<{ id: string }, (string | number)[]>(
            `SELECT c.id FROM captures_fts JOIN captures c ON c.rowid = captures_fts.rowid
             WHERE captures_fts MATCH ? AND ${where.join(" AND ")}
             ORDER BY bm25(captures_fts, 5.0, 3.0, 4.0, 1.0, 2.0), c.created_at DESC LIMIT ?`,
          )
          .all(fts, ...params, MAX)
          .map((r) => r.id)
      : [];

    let semanticIds: string[] = [];
    if (index) {
      try {
        const hits = await index.search(q, MAX);
        if (hits.length) {
          // Same filters as the keyword half, then back into similarity order.
          const allowed = new Set(
            db
              .query<{ id: string }, (string | number)[]>(
                `SELECT c.id FROM captures c WHERE c.id IN (SELECT value FROM json_each(?)) AND ${where.join(" AND ")}`,
              )
              .all(JSON.stringify(hits.map((h) => h.id)), ...params)
              .map((r) => r.id),
          );
          semanticIds = hits.map((h) => h.id).filter((id) => allowed.has(id));
        }
      } catch (err) {
        // Model still downloading or broken: keyword search keeps working.
        console.warn(`[search] semantic half failed: ${(err as Error).message}`);
      }
    }

    const ranked = fuse(keywordIds, semanticIds);
    const pageIds = ranked.slice(offset, offset + limit);
    const rows = pageIds.length
      ? db
          .query<CaptureRow, [string]>(`SELECT ${COLUMNS} FROM captures c WHERE c.id IN (SELECT value FROM json_each(?))`)
          .all(JSON.stringify(pageIds))
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items = pageIds.flatMap((id) => (byId.has(id) ? [serialize(byId.get(id)!)] : []));
    return { items, next_cursor: ranked.length > offset + limit ? String(offset + limit) : null };
  }

  app.get("/captures/:id", (c) => {
    const row = getCapture(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(full(row.id));
  });

  app.patch("/captures/:id", async (c) => {
    const id = c.req.param("id");
    if (!getCapture(id)) return c.json({ error: "not found" }, 404);
    const parsed = patchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    const b = parsed.data;

    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const set = (col: string, value: string | number | null) => {
      sets.push(`${col} = ?`);
      params.push(value);
    };
    const stamp = (flag: boolean) => (flag ? now() : null);

    if (b.title !== undefined) set("title", b.title);
    if (b.note_text !== undefined) set("note_text", b.note_text?.trim() || null);
    if (b.tags !== undefined) set("tags", JSON.stringify([...new Set(b.tags.map((t) => t.toLowerCase().trim()))]));
    if (b.kind !== undefined) set("kind", b.kind);
    if (b.pinned !== undefined) set("pinned", b.pinned ? 1 : 0);
    if (b.reviewed !== undefined) set("reviewed_at", stamp(b.reviewed));
    if (b.archived !== undefined) set("archived_at", stamp(b.archived));
    if (b.deleted !== undefined) set("deleted_at", stamp(b.deleted));
    if (b.collections !== undefined) {
      const ids = [...new Set(b.collections)];
      const known = db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM collections WHERE id IN (SELECT value FROM json_each(?))")
        .get(JSON.stringify(ids))!.n;
      if (known !== ids.length) return c.json({ error: "unknown collection" }, 400);
    }
    const url = b.watch_price ? watchUrl(getCapture(id)!) : null;
    if (b.watch_price && !url) return c.json({ error: "no link to watch" }, 400);
    db.transaction(() => {
      if (b.watch_price === false) db.query("DELETE FROM price_watches WHERE capture_id = ?").run(id);
      if (url) {
        db.query(
          `INSERT INTO price_watches (capture_id, url, next_check_at, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(capture_id) DO UPDATE SET url = excluded.url`,
        ).run(id, url, now(), now());
      }
      if (b.collections !== undefined) {
        db.query("DELETE FROM capture_collections WHERE capture_id = ?").run(id);
        for (const col of new Set(b.collections))
          db.query("INSERT INTO capture_collections (capture_id, collection_id) VALUES (?, ?)").run(id, col);
      }
      if (sets.length) {
        set("updated_at", now());
        db.query(`UPDATE captures SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
      }
    })();
    if (index && (b.title !== undefined || b.note_text !== undefined || b.tags !== undefined)) enqueue(db, id, "embed");
    return c.json(full(id));
  });

  // Soft delete goes through PATCH {deleted: true}; this is the permanent purge from trash.
  app.delete("/captures/:id", async (c) => {
    const row = getCapture(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    db.query("DELETE FROM captures WHERE id = ?").run(row.id);
    index?.remove(row.id);
    await media.remove(...[row.image_path, row.thumb_path].filter((p): p is string => !!p));
    return c.json({ ok: true });
  });

  // Multi-select on web: one change applied to many captures, all or nothing.
  app.post("/captures/bulk", async (c) => {
    const tagList = z.array(z.string().trim().min(1).max(40)).max(20);
    const idList = z.array(z.string().max(60)).max(100);
    const parsed = z
      .object({
        ids: z.array(z.string().max(60)).min(1).max(500),
        pinned: z.boolean().optional(),
        reviewed: z.boolean().optional(),
        archived: z.boolean().optional(),
        deleted: z.boolean().optional(),
        add_tags: tagList.optional(),
        remove_tags: tagList.optional(),
        add_collections: idList.optional(),
        remove_collections: idList.optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    const b = parsed.data;
    const ids = [...new Set(b.ids)];

    if (b.add_collections?.length) {
      const known = db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM collections WHERE id IN (SELECT value FROM json_each(?))")
        .get(JSON.stringify([...new Set(b.add_collections)]))!.n;
      if (known !== new Set(b.add_collections).size) return c.json({ error: "unknown collection" }, 400);
    }

    const sets: string[] = [];
    const params: (number | null)[] = [];
    const stamp = (col: string, flag: boolean) => {
      sets.push(`${col} = ?`);
      params.push(flag ? now() : null);
    };
    if (b.pinned !== undefined) {
      sets.push("pinned = ?");
      params.push(b.pinned ? 1 : 0);
    }
    if (b.reviewed !== undefined) stamp("reviewed_at", b.reviewed);
    if (b.archived !== undefined) stamp("archived_at", b.archived);
    if (b.deleted !== undefined) stamp("deleted_at", b.deleted);
    const addTags = (b.add_tags ?? []).map((t) => t.toLowerCase());
    const removeTags = new Set((b.remove_tags ?? []).map((t) => t.toLowerCase()));
    const tagsChange = addTags.length > 0 || removeTags.size > 0;

    let updated = 0;
    db.transaction(() => {
      const rows = db
        .query<{ id: string; tags: string }, [string]>("SELECT id, tags FROM captures WHERE id IN (SELECT value FROM json_each(?))")
        .all(JSON.stringify(ids));
      updated = rows.length;
      for (const row of rows) {
        const rowSets = [...sets];
        const rowParams: (string | number | null)[] = [...params];
        if (tagsChange) {
          const tags = [...new Set([...(JSON.parse(row.tags) as string[]), ...addTags])].filter((t) => !removeTags.has(t));
          rowSets.push("tags = ?");
          rowParams.push(JSON.stringify(tags));
        }
        if (rowSets.length) {
          db.query(`UPDATE captures SET ${rowSets.join(", ")}, updated_at = ? WHERE id = ?`).run(...rowParams, now(), row.id);
        }
        for (const col of new Set(b.add_collections ?? []))
          db.query("INSERT OR IGNORE INTO capture_collections (capture_id, collection_id) VALUES (?, ?)").run(row.id, col);
        for (const col of new Set(b.remove_collections ?? []))
          db.query("DELETE FROM capture_collections WHERE capture_id = ? AND collection_id = ?").run(row.id, col);
        if (index && tagsChange) enqueue(db, row.id, "embed");
      }
    })();
    return c.json({ updated });
  });

  app.post("/captures/:id/reprocess", (c) => {
    const id = c.req.param("id");
    if (!getCapture(id)) return c.json({ error: "not found" }, 404);
    enqueue(db, id);
    return c.json(full(id), 202);
  });

  app.patch("/actions/:id", async (c) => {
    const parsed = z
      .object({
        state: z.enum(["suggested", "accepted", "done", "dismissed"]).optional(),
        // Snooze moves the due time.
        due_at: z.number().int().positive().optional(),
      })
      .refine((b) => b.state !== undefined || b.due_at !== undefined)
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    const { state, due_at } = parsed.data;
    const result = db
      .query("UPDATE actions SET state = COALESCE(?, state), due_at = COALESCE(?, due_at) WHERE id = ?")
      .run(state ?? null, due_at ?? null, c.req.param("id"));
    if (result.changes === 0) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  // Upcoming reminders for the phone to offer (suggested reminders) or schedule (anything accepted). Past ones drop off.
  app.get("/reminders", (c) => {
    const rows = db
      .query<ActionRow & { capture_title: string | null }, [number]>(
        `SELECT a.*, c.title AS capture_title FROM actions a JOIN captures c ON c.id = a.capture_id
         WHERE (a.type = 'reminder' OR (a.type = 'todo' AND a.state = 'accepted'))
           AND a.state IN ('suggested', 'accepted')
           AND a.due_at IS NOT NULL AND a.due_at > ?
           AND c.deleted_at IS NULL AND c.archived_at IS NULL
         ORDER BY a.due_at LIMIT 100`,
      )
      .all(now());
    return c.json({ reminders: rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) })) });
  });

  // Things the phone should notify about straight away (price drops), newest first.
  app.get("/alerts", (c) => {
    const since = now() - 14 * 24 * 60 * 60 * 1000;
    const rows = db
      .query<ActionRow & { capture_title: string | null }, [number]>(
        `SELECT a.*, c.title AS capture_title FROM actions a JOIN captures c ON c.id = a.capture_id
         WHERE a.type = 'price_drop' AND a.state = 'suggested' AND a.created_at >= ? AND c.deleted_at IS NULL
         ORDER BY a.created_at DESC LIMIT 50`,
      )
      .all(since);
    return c.json({ alerts: rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) })) });
  });

  app.get("/media/:id/:variant{original|thumb}", async (c) => {
    const row = getCapture(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const variant = c.req.param("variant");
    const path = variant === "thumb" ? row.thumb_path : row.image_path;
    if (!path) return c.json({ error: "no image" }, 404);
    const file = Bun.file(media.path(path));
    if (!(await file.exists())) return c.json({ error: "not found" }, 404);
    return new Response(file, {
      headers: {
        "content-type": variant === "thumb" ? "image/webp" : String(row.mime),
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  });

  app.get("/tags", (c) => {
    const rows = db
      .query(
        `SELECT value AS tag, COUNT(*) AS count FROM captures, json_each(captures.tags)
         WHERE deleted_at IS NULL GROUP BY value ORDER BY count DESC LIMIT 200`,
      )
      .all();
    return c.json({ tags: rows });
  });

  // Things worth a second look: unreviewed captures from the last week plus open actions.
  app.get("/digest", (c) => {
    const since = now() - 7 * 24 * 60 * 60 * 1000;
    const unreviewed = db
      .query<CaptureRow, [number]>(
        `SELECT ${COLUMNS} FROM captures c WHERE c.deleted_at IS NULL AND c.archived_at IS NULL
         AND c.reviewed_at IS NULL AND c.created_at >= ? ORDER BY c.created_at DESC LIMIT 50`,
      )
      .all(since);
    const openActions = db
      .query<ActionRow, []>(
        `SELECT a.* FROM actions a JOIN captures c ON c.id = a.capture_id
         WHERE a.state IN ('suggested', 'accepted') AND c.deleted_at IS NULL
         ORDER BY a.created_at DESC LIMIT 50`,
      )
      .all();
    return c.json({
      unreviewed: unreviewed.map((r) => serialize(r)),
      actions: openActions.map((a) => ({ ...a, payload: JSON.parse(a.payload) })),
    });
  });

  return app;
}

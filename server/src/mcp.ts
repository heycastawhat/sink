import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import sharp from "sharp";
import { z } from "zod";
import { KINDS } from "./ai/extract";
import { fetchPublic } from "./net";

/** Calls Sink's own REST API as the MCP caller, so tools share its auth, filters and validation. */
export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

type Capture = Record<string, unknown> & {
  id: string;
  created_at: number;
  ocr_text?: string | null;
  collections?: string[];
};
type Collection = { id: string; name: string; count: number };

const IMAGE_MAX_PX = 1568;
const FETCH_MAX_BYTES = 20 * 1024 * 1024;

/**
 * MCP over Streamable HTTP, stateless: a fresh server per request (no sessions to keep),
 * JSON responses instead of SSE since no tool streams.
 */
export async function handleMcp(req: Request, api: ApiFetch, timeZone: string): Promise<Response> {
  const server = buildServer(api, timeZone);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // Response is fully built in JSON mode; nothing outlives the request.
    void server.close();
  }
}

class ToolError extends Error {}

/** Downloads an image an agent points at, public addresses only. */
async function fetchImage(raw: string): Promise<Uint8Array> {
  const res = await fetchPublic(raw, { headers: { accept: "image/*" } }).catch((err: Error) => {
    throw new ToolError(`Can't fetch ${raw}: ${err.message}`);
  });
  if (!res.ok) throw new ToolError(`Image URL returned HTTP ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > FETCH_MAX_BYTES) throw new ToolError("Image too large");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > FETCH_MAX_BYTES) throw new ToolError("Image too large");
  return bytes;
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new ToolError(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

function buildServer(api: ApiFetch, timeZone: string) {
  const server = new McpServer(
    { name: "sink", version: "1.0.0" },
    {
      instructions:
        "Sink is the user's personal archive of screenshots, notes and links. Each capture is one the AI has read: kind, " +
        "title, summary, extracted entities, the user's note on why they saved it, and its text. Search first, " +
        "then get_capture for full text or to look at the image. add_capture saves something new: a note, a link or an " +
        "image. Captures without a screenshot have has_image false.",
    },
  );

  const when = (ms: number) => ({
    created_at: new Date(ms).toISOString(),
    created_local: new Date(ms).toLocaleString("en-NZ", { timeZone, dateStyle: "medium", timeStyle: "short" }),
  });

  const brief = (c: Capture) => ({
    id: c.id,
    ...when(c.created_at),
    kind: c.kind,
    title: c.title,
    summary: c.summary,
    note: c.note_text,
    tags: c.tags,
    pinned: c.pinned,
    source_url: c.source_url ?? undefined,
    status: c.status,
    has_image: c.image_url !== null,
    text_excerpt: c.ocr_text ? c.ocr_text.slice(0, 280) : undefined,
  });

  const collections = async () => (await json<{ collections: Collection[] }>(await api("/api/collections"))).collections;

  /** Accepts collection ids or names (any case). */
  async function resolveCollections(refs: string[]) {
    if (!refs.length) return [];
    const all = await collections();
    return refs.map((ref) => {
      const hit = all.find((c) => c.id === ref || c.name.toLowerCase() === ref.toLowerCase());
      if (!hit) throw new ToolError(`No collection "${ref}". Existing: ${all.map((c) => c.name).join(", ") || "none"}`);
      return hit.id;
    });
  }

  // Tool errors go back to the model as text it can act on, not protocol errors.
  const safe =
    <A,>(fn: (args: A) => Promise<ReturnType<typeof text> | { content: unknown[] }>) =>
    async (args: A) => {
      try {
        return (await fn(args)) as any;
      } catch (err) {
        if (err instanceof ToolError) return { content: [{ type: "text" as const, text: err.message }], isError: true };
        throw err;
      }
    };

  server.registerTool(
    "search_captures",
    {
      title: "Search captures",
      description:
        "Search the user's screenshots by words or meaning (hybrid keyword + semantic). Leave query empty to browse newest first. " +
        "Returns brief results; use get_capture for everything about one.",
      inputSchema: {
        query: z.string().max(200).optional().describe('Free text, e.g. "wifi password from the airbnb"'),
        kind: z.enum(KINDS).optional(),
        tag: z.string().max(60).optional(),
        collection: z.string().max(60).optional().describe("Collection name or id"),
        view: z.enum(["all", "pinned", "archived", "trash"]).optional().describe("Default all (excludes archived and trash)"),
        limit: z.number().int().min(1).max(40).optional().describe("Default 10"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ query, kind, tag, collection, view, limit }) => {
      const qs = new URLSearchParams({ limit: String(limit ?? 10), view: view ?? "all" });
      if (query) qs.set("q", query);
      if (kind) qs.set("kind", kind);
      if (tag) qs.set("tag", tag);
      if (collection) qs.set("collection", (await resolveCollections([collection]))[0]!);
      const page = await json<{ items: Capture[]; next_cursor: string | null }>(await api(`/api/captures?${qs}`));
      return text({ results: page.items.map(brief), more: page.next_cursor !== null });
    }),
  );

  server.registerTool(
    "get_capture",
    {
      title: "Get capture",
      description:
        "Everything about one capture: full text in the image, entities (dates, prices, links, places, people), suggested actions, " +
        "collections. Set include_image to also see the screenshot itself.",
      inputSchema: {
        id: z.string().max(60),
        include_image: z.boolean().optional().describe("Attach the screenshot (downscaled JPEG)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ id, include_image }) => {
      const c = await json<Capture>(await api(`/api/captures/${encodeURIComponent(id)}`));
      const names = new Map((await collections()).map((col) => [col.id, col.name]));
      const { image_url, thumb_url, width, height, mime, ...rest } = c;
      const detail = {
        ...rest,
        ...when(c.created_at),
        has_image: image_url !== null,
        collections: (c.collections ?? []).map((cid) => names.get(cid) ?? cid),
      };
      const content: unknown[] = text(detail).content;
      if (include_image && image_url) {
        const res = await api(`/api/media/${encodeURIComponent(id)}/original`);
        if (res.ok) {
          const jpeg = await sharp(Buffer.from(await res.arrayBuffer()))
            .resize({ width: IMAGE_MAX_PX, height: IMAGE_MAX_PX, fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();
          content.push({ type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" });
        }
      }
      return { content };
    }),
  );

  server.registerTool(
    "list_collections",
    {
      title: "List collections",
      description: "The user's collections (boards they file captures into), with how many captures each holds.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(async () => text({ collections: (await collections()).map(({ id, name, count }) => ({ id, name, count })) })),
  );

  server.registerTool(
    "upcoming_reminders",
    {
      title: "Upcoming reminders",
      description: "Reminders and accepted to-dos from captures that are still in the future, soonest first.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      const { reminders } = await json<{ reminders: (Record<string, unknown> & { due_at: number })[] }>(await api("/api/reminders"));
      return text({
        reminders: reminders.map((r) => ({
          capture_id: r.capture_id,
          capture_title: r.capture_title,
          label: r.label,
          state: r.state,
          due_at: new Date(r.due_at).toISOString(),
          due_local: new Date(r.due_at).toLocaleString("en-NZ", { timeZone, dateStyle: "medium", timeStyle: "short" }),
        })),
      });
    }),
  );

  server.registerTool(
    "update_capture",
    {
      title: "Update capture",
      description:
        "Edit a capture: title, note, tags (replaces the list), pin, archive, or file it into / take it out of collections (by name or id).",
      inputSchema: {
        id: z.string().max(60),
        title: z.string().max(200).optional(),
        note: z.string().max(4000).optional(),
        tags: z.array(z.string().max(40)).max(20).optional(),
        pinned: z.boolean().optional(),
        archived: z.boolean().optional(),
        add_to_collections: z.array(z.string().max(60)).max(20).optional(),
        remove_from_collections: z.array(z.string().max(60)).max(20).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    safe(async ({ id, title, note, tags, pinned, archived, add_to_collections, remove_from_collections }) => {
      const patch: Record<string, unknown> = {};
      if (title !== undefined) patch.title = title;
      if (note !== undefined) patch.note_text = note;
      if (tags !== undefined) patch.tags = tags;
      if (pinned !== undefined) patch.pinned = pinned;
      if (archived !== undefined) patch.archived = archived;
      const add = await resolveCollections(add_to_collections ?? []);
      const remove = await resolveCollections(remove_from_collections ?? []);
      const headers = { "content-type": "application/json" };
      if (Object.keys(patch).length) {
        await json(await api(`/api/captures/${encodeURIComponent(id)}`, { method: "PATCH", headers, body: JSON.stringify(patch) }));
      }
      if (add.length || remove.length) {
        const { updated } = await json<{ updated: number }>(
          await api("/api/captures/bulk", {
            method: "POST",
            headers,
            body: JSON.stringify({ ids: [id], add_collections: add, remove_collections: remove }),
          }),
        );
        if (!updated) throw new ToolError(`No capture ${id}`);
      }
      const c = await json<Capture>(await api(`/api/captures/${encodeURIComponent(id)}`));
      return text({ updated: brief(c) });
    }),
  );

  server.registerTool(
    "add_capture",
    {
      title: "Add capture",
      description:
        "Save something new to the user's sink: a note (text), a link (url), an image, or any mix. A bare link is read so " +
        "it's searchable. The AI then files it like any screenshot (kind, title, summary, reminders), which takes a few " +
        "seconds; status is pending until then. Saving the same thing twice returns the existing capture.",
      inputSchema: {
        text: z.string().max(50_000).optional().describe("Text to keep, e.g. a recipe, an address, notes from this chat"),
        url: z.string().url().max(2000).optional().describe("Link to save, or the page the text or image came from"),
        note: z.string().max(4000).optional().describe("Why it's being saved; steers the AI and shows as the user's note"),
        image_base64: z.string().max(28_000_000).optional().describe("PNG, JPEG, WebP or HEIC, base64"),
        image_url: z.string().url().max(2000).optional().describe("Public URL of an image to download and keep"),
        collections: z.array(z.string().max(60)).max(20).optional().describe("Collection names or ids to file it into"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async ({ text: body, url, note, image_base64, image_url, collections: cols }) => {
      if (image_base64 && image_url) throw new ToolError("Give image_base64 or image_url, not both");
      if (!body?.trim() && !url && !image_base64 && !image_url) throw new ToolError("Nothing to save: give text, url or an image");
      const collectionIds = await resolveCollections(cols ?? []);

      const form = new FormData();
      form.set("source", "mcp");
      if (body?.trim()) form.set("text", body.trim());
      if (url) form.set("source_url", url);
      if (note?.trim()) form.set("note", note.trim());
      const image = image_url
        ? await fetchImage(image_url)
        : image_base64 && new Uint8Array(Buffer.from(image_base64.replace(/^data:[^,]*,/, ""), "base64"));
      if (image) form.set("image", new File([image], "capture"));
      const c = await json<Capture>(await api("/api/captures", { method: "POST", body: form }));

      if (collectionIds.length) {
        await json(
          await api("/api/captures/bulk", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ids: [c.id], add_collections: collectionIds }),
          }),
        );
      }
      return text({ added: brief(c), collections: cols ?? [] });
    }),
  );

  server.registerTool(
    "create_collection",
    {
      title: "Create collection",
      description: "Make a new collection to file captures into.",
      inputSchema: { name: z.string().min(1).max(60) },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    safe(async ({ name }) => {
      const col = await json<Collection>(
        await api("/api/collections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }),
      );
      return text({ created: { id: col.id, name: col.name } });
    }),
  );

  return server;
}

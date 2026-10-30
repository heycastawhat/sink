import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { COLORS } from "./notes";
import type { McpToolDef, McpToolHandler } from "./plugins";

/** Calls Sink's own REST API as the MCP caller, so tools share its auth, filters and validation. */
export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * MCP over Streamable HTTP, stateless: a fresh server per request (no sessions to keep),
 * JSON responses instead of SSE since no tool streams.
 */
export async function handleMcp(req: Request, api: ApiFetch, timeZone: string, extra: PluginTool[] = [], origin = ""): Promise<Response> {
  const server = buildServer(api, timeZone, extra, origin);
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

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new ToolError(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

type PluginTool = { name: string; def: McpToolDef; handler: McpToolHandler };

function buildServer(api: ApiFetch, timeZone: string, extra: PluginTool[], origin: string) {
  const server = new McpServer(
    {
      name: "sink",
      title: "Sink",
      version: "2.1.0",
      // Sink's own logo for connector screens (they'd otherwise guess at a favicon).
      ...(origin && {
        websiteUrl: origin,
        icons: [
          { src: `${origin}/favicon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
          { src: `${origin}/icon-192.png`, mimeType: "image/png", sizes: ["192x192"] },
          { src: `${origin}/icon-512.png`, mimeType: "image/png", sizes: ["512x512"] },
        ],
      }),
    },
    {
      instructions:
        "Sink is the user's notes app: markdown files in their vault (Obsidian-compatible, organised in folders), plus " +
        "todos, which are `- [ ]` checkbox lines inside notes (Tasks plugin syntax: `📅 YYYY-MM-DD` due date, " +
        "`(@YYYY-MM-DD HH:mm)` reminder). Search first, then read_note for the full text. save_note creates or replaces " +
        "a note; add_todo appends a todo to Todo.md and complete_todo ticks one off. Notes and folders can be moved, " +
        "renamed and trashed; the trash keeps them for the user to restore, so nothing is ever deleted for good from here.",
    },
  );

  // Tool errors go back to the model as text it can act on, not protocol errors.
  const safe =
    <A,>(fn: (args: A) => Promise<{ content: { type: "text"; text: string }[] }>) =>
    async (args: A) => {
      try {
        return (await fn(args)) as any;
      } catch (err) {
        if (err instanceof ToolError) return { content: [{ type: "text" as const, text: err.message }], isError: true };
        throw err;
      }
    };
  const local = (ms: number) => new Date(ms).toLocaleString("en-GB", { timeZone, dateStyle: "medium", timeStyle: "short" });

  type NoteMeta = { path: string; title: string; tags: string[]; mtime: number; hash: string; snippet?: string };
  const noteBrief = (n: NoteMeta) => ({
    path: n.path,
    title: n.title,
    tags: n.tags,
    modified_local: local(n.mtime),
    ...(n.snippet && { snippet: n.snippet }),
  });
  const pathQs = (path: string) => `path=${encodeURIComponent(path)}`;

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Search the user's markdown notes by words (title, text, tags, path). Leave query empty to list notes, newest " +
        "first, plus the folder list; give folder to list just that folder (and the folders inside it). Use read_note " +
        "for a note's full text.",
      inputSchema: {
        query: z.string().max(200).optional(),
        folder: z.string().max(1024).optional().describe('Only notes in this folder and below, e.g. "Projects"'),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ query, folder, limit }) => {
      const base = folder?.trim().replace(/^\/+|\/+$/g, "") ?? "";
      const inFolder = (p: string) => !base || p.startsWith(base + "/");
      if (query?.trim()) {
        // Search wide, then narrow to the folder, so a folder filter doesn't eat the limit.
        const { items } = await json<{ items: NoteMeta[] }>(
          await api(`/api/notes?q=${encodeURIComponent(query)}&limit=${base ? 100 : (limit ?? 20)}`),
        );
        return text({ results: items.filter((n) => inFolder(n.path)).slice(0, limit ?? 20).map(noteBrief) });
      }
      const all = await json<{ notes: NoteMeta[]; folders: string[] }>(await api("/api/notes"));
      if (base && !all.folders.includes(base)) throw new ToolError(`No folder "${base}". Folders: ${all.folders.join(", ") || "none"}`);
      const notes = all.notes.filter((n) => inFolder(n.path));
      const folders = all.folders.filter(inFolder);
      return text({ notes: notes.slice(0, limit ?? 20).map(noteBrief), total: notes.length, folders });
    }),
  );

  server.registerTool(
    "read_note",
    {
      title: "Read note",
      description:
        "Full markdown of one note, plus the hash save_note needs to edit it and the notes that link to it (linked_from). " +
        "Give the path from search_notes " +
        '(e.g. "Inbox/Door code.md"); a title or a name without ".md" also works.',
      inputSchema: { path: z.string().max(1024).describe("Vault path, file name or title") },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ path }) => {
      const n = await findNote(path);
      const links = await api(`/api/notes/backlinks?${pathQs(n.path)}`)
        .then((r) => json<{ items: { path: string }[] }>(r))
        .catch(() => ({ items: [] }));
      const linked_from = links.items.map((i) => i.path);
      // The markdown goes back as its own text block, not escaped inside JSON, so it reads as the note.
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ ...noteBrief(n), hash: n.hash, ...(linked_from.length && { linked_from }) }, null, 2) },
          { type: "text" as const, text: n.content },
        ],
      };
    }),
  );

  /** A note by vault path, falling back to file name or title, since assistants often pass what they saw. */
  async function findNote(ref: string): Promise<NoteMeta & { content: string }> {
    const clean = ref.trim().replace(/^\/+/, "");
    const asPath = /\.md$/i.test(clean) ? clean : `${clean}.md`;
    const direct = await api(`/api/notes/file?${pathQs(asPath)}`);
    if (direct.ok) return json(direct);
    const { notes } = await json<{ notes: NoteMeta[] }>(await api("/api/notes"));
    const want = clean.replace(/\.md$/i, "").toLowerCase();
    const name = (p: string) => p.split("/").pop()!.replace(/(\.excalidraw)?\.md$/i, "").toLowerCase();
    const hits = notes.filter((n) => name(n.path) === want || n.title.toLowerCase() === want);
    if (hits.length === 1) return json(await api(`/api/notes/file?${pathQs(hits[0]!.path)}`));
    if (hits.length > 1) throw new ToolError(`Several notes match "${ref}": ${hits.map((h) => h.path).join(", ")}. Pass one of these paths.`);
    throw new ToolError(`No note "${ref}". Use search_notes to find its path.`);
  }

  server.registerTool(
    "save_note",
    {
      title: "Save note",
      description:
        "Write a markdown note. To create one, give title (and optionally folder) with no path; it lands at " +
        "<folder>/<title>.md, numbered if the name is taken. To edit one, give path and the hash from read_note; the whole " +
        "content is replaced, so read first and keep what should stay. A stale hash fails rather than overwrite the user's edits.",
      inputSchema: {
        content: z.string().max(1_000_000).describe("Full markdown. Start with '# Title' so the note has a heading."),
        path: z.string().max(1024).optional().describe("Existing note to replace"),
        hash: z.string().max(64).optional().describe("From read_note; required with path"),
        title: z.string().max(200).optional().describe("For a new note: its file name"),
        folder: z.string().max(1024).optional().describe('For a new note, e.g. "Inbox" or "Projects/Sink". Default: vault root'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async ({ content, path, hash, title, folder }) => {
      const headers = { "content-type": "application/json" };
      if (path) {
        if (!hash) throw new ToolError("Editing needs the hash from read_note");
        const n = await json<NoteMeta>(
          await api(`/api/notes/file?${pathQs(path)}`, { method: "PUT", headers, body: JSON.stringify({ content, base_hash: hash }) }),
        );
        return text({ saved: noteBrief(n), hash: n.hash });
      }
      const n = await json<NoteMeta>(
        await api("/api/notes", { method: "POST", headers, body: JSON.stringify({ content, title: title ?? "", folder: folder ?? "" }) }),
      );
      return text({ created: noteBrief(n), hash: n.hash });
    }),
  );

  type Todo = { path: string; line: number; raw: string; text: string; status: string; due: string | null; remind_at: number | null; note_title: string };

  server.registerTool(
    "list_todos",
    {
      title: "List todos",
      description: "Open todos from every note, dated ones first (soonest first). Set done to list finished ones instead.",
      inputSchema: { done: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ done }) => {
      const { todos, today } = await json<{ todos: Todo[]; today: string }>(await api(`/api/todos?view=${done ? "done" : "open"}`));
      return text({
        today,
        todos: todos.map((t) => ({
          text: t.text,
          due: t.due,
          remind_local: t.remind_at ? local(t.remind_at) : undefined,
          note: t.note_title,
          path: t.path,
          line: t.line,
          raw: t.raw,
        })),
      });
    }),
  );

  server.registerTool(
    "add_todo",
    {
      title: "Add todo",
      description: "Add a todo to Todo.md (or another note by path), with an optional due date and reminder time in the user's time zone.",
      inputSchema: {
        text: z.string().min(1).max(2000),
        due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD"),
        time: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe("HH:mm reminder time on the due date"),
        path: z.string().max(1024).optional().describe("Note to add it to; default Todo.md"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    safe(async (args) => {
      const added = await json<{ path: string; raw: string }>(
        await api("/api/todos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) }),
      );
      return text({ added: added.raw, path: added.path });
    }),
  );

  server.registerTool(
    "complete_todo",
    {
      title: "Complete todo",
      description:
        "Tick a todo off (or set done=false to reopen it). Pass path, line and raw exactly as list_todos gave them; if the " +
        "note changed since, the same line elsewhere in it still counts.",
      inputSchema: {
        path: z.string().max(1024),
        line: z.number().int().min(0),
        raw: z.string().max(4000),
        done: z.boolean().optional().describe("Default true"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    safe(async ({ path, line, raw, done }) => {
      const out = await json<{ raw: string }>(
        await api("/api/todos/toggle", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, line, raw, done: done ?? true }),
        }),
      );
      return text({ [done === false ? "reopened" : "done"]: out.raw, path });
    }),
  );

  server.registerTool(
    "create_folder",
    {
      title: "Create folder",
      description: 'Make a folder (and any parents), e.g. "Projects/Sink". Fine if it already exists.',
      inputSchema: { path: z.string().min(1).max(1024) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    safe(async ({ path }) => {
      const out = await json<{ path: string }>(
        await api("/api/notes/folders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) }),
      );
      return text({ folder: out.path });
    }),
  );

  server.registerTool(
    "move_note",
    {
      title: "Move or rename",
      description:
        "Move or rename a note or a whole folder. For a note, to is its new full path (keep .md), e.g. " +
        '"Inbox/Idea.md" -> "Projects/Sink/Idea.md"; give folder instead to keep the name and just change folder ' +
        '("" for the top level). For a folder, to is its new path. Fails rather than overwrite something already there.',
      inputSchema: {
        from: z.string().min(1).max(1024).describe("Note path (or title) or folder path"),
        to: z.string().max(1024).optional(),
        folder: z.string().max(1024).optional().describe("Notes only: the folder to move it into, keeping its name"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    safe(async ({ from, to, folder }) => {
      const { folders } = await json<{ folders: string[] }>(await api("/api/notes"));
      const src = from.trim().replace(/^\/+|\/+$/g, "");
      const isFolder = !/\.md$/i.test(src) && folders.includes(src);
      const source = isFolder ? src : (await findNote(src)).path;
      let dest = to?.trim().replace(/^\/+|\/+$/g, "");
      if (folder !== undefined && !isFolder) {
        const dir = folder.trim().replace(/^\/+|\/+$/g, "");
        dest = (dir ? dir + "/" : "") + source.split("/").pop();
      }
      if (!dest) throw new ToolError("Give to (the new path) or folder");
      if (!isFolder && !/\.md$/i.test(dest)) dest += source.toLowerCase().endsWith(".excalidraw.md") ? ".excalidraw.md" : ".md";
      const out = await json<{ path: string }>(
        await api("/api/notes/move", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: source, to: dest }) }),
      );
      return text({ moved: source, to: out.path });
    }),
  );

  server.registerTool(
    "trash_note",
    {
      title: "Move to trash",
      description:
        "Move a note, or a folder with everything in it, to Sink's trash. The user can restore it (so can restore_from_trash); " +
        "only they can delete it for good.",
      inputSchema: { path: z.string().min(1).max(1024).describe("Note path (or title) or folder path") },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async ({ path }) => {
      const { folders } = await json<{ folders: string[] }>(await api("/api/notes"));
      const src = path.trim().replace(/^\/+|\/+$/g, "");
      const target = !/\.md$/i.test(src) && folders.includes(src) ? src : (await findNote(src)).path;
      const out = await json<{ trashed_to: string }>(await api(`/api/notes/file?${pathQs(target)}`, { method: "DELETE" }));
      return text({ trashed: target, trash_path: out.trashed_to });
    }),
  );

  type Trashed = { path: string; original: string; title: string; excerpt: string; deleted_at: number; folder?: string };

  server.registerTool(
    "list_trash",
    {
      title: "List trash",
      description:
        "What's in Sink's trash, newest first, with where each came from. A folder trashed whole is one item (restore it " +
        "whole). Use restore_from_trash to put one back.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      const { items, days } = await json<{ items: Trashed[]; days: number }>(await api("/api/notes/trash"));
      // Notes from a folder that was trashed whole collapse into that folder.
      const out: Record<string, unknown>[] = [];
      const folders = new Map<string, { trash_path: string; original: string; notes: string[]; deleted_local: string }>();
      for (const t of items) {
        if (!t.folder) {
          out.push({ trash_path: t.path, original: t.original, title: t.title, deleted_local: local(t.deleted_at) });
          continue;
        }
        let f = folders.get(t.folder);
        if (!f) {
          const original = t.original.slice(0, t.original.length - (t.path.length - t.folder.length));
          f = { trash_path: t.folder, original, notes: [], deleted_local: local(t.deleted_at) };
          folders.set(t.folder, f);
          out.push({ folder: true, ...f });
        }
        f.notes.push(t.title);
      }
      return text({ kept_for_days: days || "until emptied", items: out });
    }),
  );

  server.registerTool(
    "restore_from_trash",
    {
      title: "Restore from trash",
      description: "Put a trashed note or folder back where it was (numbered if that name is taken now). Pass trash_path from list_trash.",
      inputSchema: { trash_path: z.string().min(1).max(1024) },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    safe(async ({ trash_path }) => {
      const out = await json<{ path: string; notes?: number }>(
        await api("/api/notes/trash/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: trash_path }) }),
      );
      return text({ restored: out.path, ...(out.notes !== undefined && { notes: out.notes }) });
    }),
  );

  server.registerTool(
    "style_note",
    {
      title: "Pin or colour a note",
      description: "Pin a note to the top of the user's grid, or give it a Keep-style colour (null clears it).",
      inputSchema: {
        path: z.string().min(1).max(1024).describe("Note path or title"),
        pinned: z.boolean().optional(),
        color: z.enum(COLORS as [string, ...string[]]).nullable().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    safe(async ({ path, pinned, color }) => {
      if (pinned === undefined && color === undefined) throw new ToolError("Give pinned and/or color");
      const n = await findNote(path);
      const out = await json<NoteMeta & { pinned?: boolean; color?: string | null }>(
        await api(`/api/notes/meta?${pathQs(n.path)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pinned, color }),
        }),
      );
      return text({ path: out.path, pinned: !!out.pinned, color: out.color ?? null });
    }),
  );

  // Tools added by plugins. Their errors go back to the model as text, like ours.
  for (const tool of extra) {
    server.registerTool(
      tool.name,
      {
        title: tool.def.title ?? tool.name,
        description: tool.def.description,
        inputSchema: tool.def.inputSchema,
        annotations: { readOnlyHint: tool.def.readOnly ?? false },
      },
      async (args: unknown) => {
        try {
          const out = await tool.handler(args);
          return { content: [{ type: "text" as const, text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true };
        }
      },
    );
  }

  return server;
}

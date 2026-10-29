import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

/** Calls Sink's own REST API as the MCP caller, so tools share its auth, filters and validation. */
export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

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

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new ToolError(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

function buildServer(api: ApiFetch, timeZone: string) {
  const server = new McpServer(
    { name: "sink", version: "2.0.0" },
    {
      instructions:
        "Sink is the user's notes app: markdown files in their vault (Obsidian-compatible, organised in folders), plus " +
        "todos, which are `- [ ]` checkbox lines inside notes (Tasks plugin syntax: `📅 YYYY-MM-DD` due date, " +
        "`(@YYYY-MM-DD HH:mm)` reminder). Search first, then read_note for the full text. save_note creates or replaces " +
        "a note; add_todo appends a todo to Todo.md.",
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
        "Search the user's markdown notes by words (title, text, tags, path). Leave query empty to list every note, newest " +
        "first, plus the folder list. Use read_note for a note's full text.",
      inputSchema: {
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ query, limit }) => {
      if (query?.trim()) {
        const { items } = await json<{ items: NoteMeta[] }>(
          await api(`/api/notes?q=${encodeURIComponent(query)}&limit=${limit ?? 20}`),
        );
        return text({ results: items.map(noteBrief) });
      }
      const { notes, folders } = await json<{ notes: NoteMeta[]; folders: string[] }>(await api("/api/notes"));
      return text({ notes: notes.slice(0, limit ?? 20).map(noteBrief), total: notes.length, folders });
    }),
  );

  server.registerTool(
    "read_note",
    {
      title: "Read note",
      description:
        "Full markdown of one note, plus the hash save_note needs to edit it. Give the path from search_notes " +
        '(e.g. "Inbox/Door code.md"); a title or a name without ".md" also works.',
      inputSchema: { path: z.string().max(1024).describe("Vault path, file name or title") },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ path }) => {
      const n = await findNote(path);
      // The markdown goes back as its own text block, not escaped inside JSON, so it reads as the note.
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ ...noteBrief(n), hash: n.hash }, null, 2) },
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

  type Todo = { path: string; line: number; text: string; status: string; due: string | null; remind_at: number | null; note_title: string };

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

  return server;
}

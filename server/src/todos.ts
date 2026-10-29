import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "./auth";
import { localIso, localTime } from "./time";
import { VaultError, type Vault } from "./notes";

/**
 * Todos are checkbox lines in notes, written the way Obsidian's Tasks plugin writes them, so both apps read the same file:
 *   - [ ] Pay rates 📅 2026-11-02 ⏫
 *   - [x] Book flights ✅ 2026-10-20
 *   - [ ] Call mum (@2026-10-30 18:00)        <- reminder time, the Obsidian Reminder plugin's syntax
 * A due date with no reminder time reminds at 9am that day.
 */

export const TODO_FILE = "Todo.md";
const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+\[)(.)(\]\s+)(.*)$/;
const DATE = String.raw`\d{4}-\d{2}-\d{2}`;
const FIELD = new RegExp(String.raw`\s*(?:[📅⏳🛫✅➕❌]️?\s*${DATE}|[⏫🔼🔽🔺⏬]️?|🔁️?[^📅⏳🛫✅➕❌⏫🔼🔽🔺⏬(]*|\(@${DATE}(?:[ T]\d{1,2}:\d{2})?\))`, "gu");

export type Todo = {
  line: number;
  raw: string;
  text: string;
  status: "open" | "done" | "cancelled";
  due: string | null;
  remind_at: number | null;
  done_on: string | null;
};

/** Every task line in a note, skipping frontmatter and code blocks. Lines are 0-based. */
export function parseTodos(content: string, timeZone: string): Todo[] {
  const lines = content.split("\n");
  const out: Todo[] = [];
  let fence: string | null = null;
  let i = 0;
  if (lines[0]?.trimEnd() === "---") {
    const end = lines.findIndex((l, n) => n > 0 && l.trimEnd() === "---");
    if (end > 0) i = end + 1;
  }
  for (; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      if (!fence) fence = f[1]!;
      else if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fence) continue;
    const m = TASK.exec(line);
    if (!m) continue;
    const mark = m[2]!;
    const rest = m[4]!;
    const due = new RegExp(`📅\\uFE0F?\\s*(${DATE})`, "u").exec(rest)?.[1] ?? null;
    const doneOn = new RegExp(`✅\\uFE0F?\\s*(${DATE})`, "u").exec(rest)?.[1] ?? null;
    const remind = new RegExp(`\\(@(${DATE})(?:[ T](\\d{1,2}):(\\d{2}))?\\)`).exec(rest);
    const remindRaw = remind ? (remind[2] ? `${remind[1]}T${remind[2].padStart(2, "0")}:${remind[3]}:00` : remind[1]!) : due;
    const status = mark === " " || !/[xX-]/.test(mark) ? "open" : mark === "-" ? "cancelled" : "done";
    out.push({
      line: i,
      raw: line,
      text: rest.replace(FIELD, "").replace(/\s+/g, " ").trim(),
      status,
      // A reminder with no due date still dates the todo.
      due: due ?? remind?.[1] ?? null,
      remind_at: remindRaw ? localTime(remindRaw, timeZone) : null,
      done_on: doneOn,
    });
  }
  return out;
}

/** Ticks or unticks one task line, adding or removing the `✅ date` Tasks uses. */
export function setDone(raw: string, done: boolean, today: string): string {
  const m = TASK.exec(raw);
  if (!m) throw new Error("not a task line");
  const rest = m[4]!.replace(new RegExp(`\\s*✅\\uFE0F?\\s*${DATE}`, "u"), "");
  return `${m[1]}${done ? "x" : " "}${m[3]}${done ? `${rest} ✅ ${today}` : rest}`;
}

/** A new task line from free text, with an optional due date (YYYY-MM-DD) and reminder time (HH:mm). */
export function todoLine(text: string, due?: string, time?: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (due && time) return `- [ ] ${clean} 📅 ${due} (@${due} ${time})`;
  return `- [ ] ${clean}${due ? ` 📅 ${due}` : ""}`;
}

type Row = Omit<Todo, "line"> & { line: number; path: string; note_title: string; mtime: number };

const toggleBody = z.object({
  path: z.string().min(1).max(1024),
  line: z.number().int().min(0),
  raw: z.string().max(10_000),
  done: z.boolean(),
});
const addBody = z.object({
  text: z.string().trim().min(1).max(2000),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  time: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
  path: z.string().max(1024).optional(),
});
const listQuery = z.object({ view: z.enum(["open", "done", "all"]).default("open") });

export function todoRoutes(db: Database, vault: Vault, timeZone: string) {
  const app = new Hono<AuthEnv>();
  const today = () => localIso(new Date(), timeZone).slice(0, 10);

  app.get("/todos", (c) => {
    const q = listQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid query" }, 400);
    const where = q.data.view === "open" ? "t.status = 'open'" : q.data.view === "done" ? "t.status != 'open'" : "1";
    // Open: dated first by date, then undated newest-note first. Done: most recently finished first.
    const order =
      q.data.view === "open"
        ? "t.due IS NULL, t.due, n.mtime DESC, t.path, t.line"
        : "t.done_on IS NULL, t.done_on DESC, n.mtime DESC, t.path, t.line";
    const rows = db
      .query<Row, []>(
        `SELECT t.path, t.line, t.raw, t.text, t.status, t.due, t.remind_at, t.done_on, n.title AS note_title, n.mtime
         FROM todos t JOIN notes n ON n.path = t.path WHERE ${where} ORDER BY ${order} LIMIT 500`,
      )
      .all();
    return c.json({ todos: rows, today: today() });
  });

  // Ticks one line. The client sends the line as it saw it; if the file moved on, the same text elsewhere still counts.
  app.post("/todos/toggle", async (c) => {
    const body = toggleBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const { path, line, raw, done } = body.data;
    try {
      for (let attempt = 0; ; attempt++) {
        const note = await vault.read(path);
        const lines = note.content.split("\n");
        const strip = (l: string) => l.replace(/\r$/, "");
        let at = strip(lines[line] ?? "") === raw ? line : -1;
        if (at < 0) {
          const matches = lines.flatMap((l, i) => (strip(l) === raw ? [i] : []));
          if (matches.length !== 1) return c.json({ error: "todo changed; reload" }, 409);
          at = matches[0]!;
        }
        const cr = lines[at]!.endsWith("\r") ? "\r" : "";
        lines[at] = setDone(raw, done, today()) + cr;
        try {
          await vault.write(path, lines.join("\n"), note.hash);
          return c.json({ ok: true, line: at, raw: strip(lines[at]!) });
        } catch (err) {
          // Someone saved the note between our read and write: try once more on the new text.
          if (err instanceof VaultError && err.status === 409 && attempt === 0) continue;
          throw err;
        }
      }
    } catch (err) {
      if (err instanceof VaultError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  // Quick todo: appended to Todo.md (or another note), created if missing.
  app.post("/todos", async (c) => {
    const body = addBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const { text, due, time, path = TODO_FILE } = body.data;
    const line = todoLine(text, due, time);
    try {
      for (let attempt = 0; ; attempt++) {
        const note = await vault.read(path).catch((err) => {
          if (err instanceof VaultError && err.status === 404) return null;
          throw err;
        });
        const base = note ? note.content : "# Todo\n\n";
        const content = `${base}${base.endsWith("\n") || !base ? "" : "\n"}${line}\n`;
        try {
          const saved = await vault.write(path, content, note?.hash ?? null);
          return c.json({ ok: true, path: saved.path, line: content.split("\n").length - 2, raw: line }, 201);
        } catch (err) {
          if (err instanceof VaultError && err.status === 409 && attempt === 0) continue;
          throw err;
        }
      }
    } catch (err) {
      if (err instanceof VaultError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  return app;
}

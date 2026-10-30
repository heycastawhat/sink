import type { Database } from "bun:sqlite";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AuthEnv } from "./auth";
import { localIso, localTime } from "./time";
import { VaultError, type Vault } from "./notes";

/**
 * Todos are checkbox lines in notes, written the way Obsidian's Tasks plugin writes them, so both apps read the same file:
 *   - [ ] Pay rates 📅 2026-11-02 ⏫
 *   - [x] Book flights ✅ 2026-10-20
 *   - [ ] Call mum (@2026-10-30 18:00)        <- reminder time, the Obsidian Reminder plugin's syntax
 * A due date with no reminder time reminds at 9am that day. A scheduled date (⏳) stands in for a missing due date;
 * a start date (🛫) keeps the todo out of the way until then.
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
  /** 0 highest (🔺), 1 high (⏫), 2 medium (🔼), 3 none, 4 low (🔽), 5 lowest (⏬). */
  priority: number;
  start: string | null;
  scheduled: string | null;
};

const PRIORITIES = ["🔺", "⏫", "🔼", "", "🔽", "⏬"];
const dateField = (mark: string, rest: string) => new RegExp(`${mark}\\uFE0F?\\s*(${DATE})`, "u").exec(rest)?.[1] ?? null;

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
    const due = dateField("📅", rest);
    const scheduled = dateField("⏳", rest);
    const doneOn = dateField("✅", rest) ?? dateField("❌", rest);
    const priority = /[🔺⏫🔼🔽⏬]/u.exec(rest)?.[0];
    const remind = new RegExp(`\\(@(${DATE})(?:[ T](\\d{1,2}):(\\d{2}))?\\)`).exec(rest);
    const remindRaw = remind ? (remind[2] ? `${remind[1]}T${remind[2].padStart(2, "0")}:${remind[3]}:00` : remind[1]!) : due;
    const status = mark === " " || !/[xX-]/.test(mark) ? "open" : mark === "-" ? "cancelled" : "done";
    out.push({
      line: i,
      raw: line,
      text: rest.replace(FIELD, "").replace(/\s+/g, " ").trim(),
      status,
      // A scheduled date or a reminder with no due date still dates the todo.
      due: due ?? scheduled ?? remind?.[1] ?? null,
      remind_at: remindRaw ? localTime(remindRaw, timeZone) : null,
      done_on: doneOn,
      priority: priority ? PRIORITIES.indexOf(priority) : 3,
      start: dateField("🛫", rest),
      scheduled,
    });
  }
  return out;
}

/** Sets a task line's status, with the `✅ date` (done) or `❌ date` (cancelled) Tasks writes. */
export function setStatus(raw: string, status: "open" | "done" | "cancelled", today: string): string {
  const m = TASK.exec(raw);
  if (!m) throw new Error("not a task line");
  const rest = m[4]!.replace(new RegExp(`\\s*[✅❌]\\uFE0F?\\s*${DATE}`, "gu"), "");
  const [mark, stamp] = status === "done" ? ["x", ` ✅ ${today}`] : status === "cancelled" ? ["-", ` ❌ ${today}`] : [" ", ""];
  return `${m[1]}${mark}${m[3]}${rest}${stamp}`;
}

/** Ticks or unticks one task line. */
export const setDone = (raw: string, done: boolean, today: string) => setStatus(raw, done ? "done" : "open", today);

/** A new task line from free text, with an optional due date (YYYY-MM-DD), reminder time (HH:mm) and repeat rule. */
export function todoLine(text: string, due?: string, time?: string, every?: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const repeat = every ? ` 🔁 ${every}` : "";
  if (due && time) return `- [ ] ${clean}${repeat} 📅 ${due} (@${due} ${time})`;
  return `- [ ] ${clean}${repeat}${due ? ` 📅 ${due}` : ""}`;
}

const REMINDER = new RegExp(String.raw`\s*\(@(${DATE})(?:[ T](\d{1,2}:\d{2}))?\)`);
const DUE = new RegExp(String.raw`\s*📅\uFE0F?\s*(${DATE})`, "u");
const SCHEDULED = new RegExp(String.raw`\s*⏳\uFE0F?\s*(${DATE})`, "u");

/**
 * A task line with new text, due date or reminder time; whatever isn't passed stays as it was. Other Tasks fields
 * (priority, recurrence, start dates) and a trailing block id are kept. Moving the date keeps the reminder's time
 * unless `time` says otherwise; null clears.
 */
export function editTodo(raw: string, change: { text?: string; due?: string | null; time?: string | null }): string {
  const m = TASK.exec(raw);
  if (!m) throw new Error("not a task line");
  let rest = m[4]!;
  const id = /\s+\^[\w-]+$/.exec(rest)?.[0] ?? "";
  rest = rest.slice(0, rest.length - id.length);
  if (change.text !== undefined) {
    const fields = (rest.match(FIELD) ?? []).map((f) => f.trim());
    rest = [change.text.replace(/\s+/g, " ").trim(), ...fields].join(" ");
  }
  if (change.due !== undefined || change.time !== undefined) {
    const reminder = REMINDER.exec(rest);
    const due = change.due === undefined ? (DUE.exec(rest)?.[1] ?? reminder?.[1] ?? null) : change.due;
    const time = change.time === undefined ? (reminder?.[2] ?? null) : change.time;
    // A todo dated only by its scheduled date (⏳) is moved by that, so it stays scheduled rather than becoming due.
    const mark = !DUE.test(rest) && SCHEDULED.test(rest) ? "⏳" : "📅";
    rest = rest.replace(DUE, "").replace(SCHEDULED, mark === "⏳" ? "" : "$&").replace(REMINDER, "");
    if (due) rest += ` ${mark} ${due}${time ? ` (@${due} ${time})` : ""}`;
  }
  return `${m[1]}${m[2]}${m[3]}${rest.trim()}${id}`;
}

// ---------- quick add ----------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = String.raw`(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|rsday|urday)?`;
const MONTH_NAMES = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*`;
const TAIL_TIME = new RegExp(String.raw`\s+(?:at\s+)?(noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2})$`, "i");
const TAIL_DATE = new RegExp(
  String.raw`\s+(?:on\s+|by\s+|due\s+)?(today|tonight|tomorrow|tmrw|next week|in \d+ (?:days?|weeks?|months?)|(?:next\s+)?${DAY_NAMES}|\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)?\s+${MONTH_NAMES}|${MONTH_NAMES}\s+\d{1,2}(?:st|nd|rd|th)?)$`,
  "i",
);
const TAIL_EVERY = /\s+(every\s+.+)$/i;

function clock(word: string): string | null {
  const w = word.toLowerCase().replace(/\s+/g, "");
  if (w === "noon") return "12:00";
  if (w === "midnight") return "00:00";
  const m = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(w);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  return h < 24 && min < 60 ? `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}` : null;
}

function day(word: string, today: string): string | null {
  const w = word.toLowerCase().replace(/\s+/g, " ");
  if (w === "today" || w === "tonight") return today;
  if (w === "tomorrow" || w === "tmrw") return addDays(today, 1);
  if (w === "next week") return nextDate("every monday", today);
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return w;
  const inN = /^in (\d+) (day|week|month)s?$/.exec(w);
  if (inN) return inN[2] === "month" ? addMonths(today, Number(inN[1])) : addDays(today, Number(inN[1]) * (inN[2] === "week" ? 7 : 1));
  const named = /^(next )?([a-z]+)$/.exec(w);
  if (named) {
    const i = WEEKDAYS.findIndex((d) => d.startsWith(named[2]!.slice(0, 3)));
    // "friday" is the coming Friday, today if it's Friday; "next friday" is never today.
    if (i >= 0) return nextDate(`every ${WEEKDAYS[i]}`, named[1] ? today : addDays(today, -1));
  }
  const dm = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)$/.exec(w) ?? /^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?$/.exec(w)?.slice().reverse();
  if (dm) {
    const [d, mon] = /^\d/.test(dm[1]!) ? [Number(dm[1]), dm[2]!] : [Number(dm[0]), dm[1]!];
    const month = MONTHS.indexOf(mon.slice(0, 3));
    if (month < 0 || d < 1 || d > 31) return null;
    // The next one: 3 Jan typed in December is next year's.
    let year = Number(today.slice(0, 4));
    const iso = (y: number) => `${y}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (iso(year) < today) year++;
    return iso(year);
  }
  return null;
}

/**
 * Reads a date, time and/or repeat off the end of a quick todo: "call mum tomorrow 6pm", "rates fri", "bins every
 * tuesday", "dentist on 3 nov at 2:30pm". Only the end of the text, so "read Monday's notes" stays as typed.
 */
export function parseQuick(input: string, today: string): { text: string; due?: string; time?: string; every?: string } {
  let text = input.replace(/\s+/g, " ").trim();
  let due: string | undefined;
  let time: string | undefined;
  let every: string | undefined;
  for (let changed = true; changed; ) {
    changed = false;
    const t = !time && TAIL_TIME.exec(text);
    if (t && clock(t[1]!)) {
      time = clock(t[1]!)!;
      text = text.slice(0, t.index);
      changed = true;
      continue;
    }
    const e = !every && !due && TAIL_EVERY.exec(text);
    // The first one is due today if the rule allows it ("every day", "every friday" on a Friday).
    const first = e && nextDate(e[1]!, addDays(today, -1));
    if (e && first) {
      every = e[1]!.toLowerCase();
      due = /^every\s+(?:\d+\s+)?(?:week|month|year)s?$/i.test(every) ? today : first;
      text = text.slice(0, e.index);
      changed = true;
      continue;
    }
    const d = !due && !every && TAIL_DATE.exec(text);
    if (d && day(d[1]!, today)) {
      due = day(d[1]!, today)!;
      if (/^tonight$/i.test(d[1]!) && !time) time = "19:00";
      text = text.slice(0, d.index);
      changed = true;
    }
  }
  // Nothing left but the date ("tomorrow"): keep it all as the text.
  if (!text.trim()) return { text: input.trim() };
  // A time alone ("call at 4pm") is today's.
  if (time && !due) due = today;
  return { text: text.trim(), due, time, every };
}

// ---------- recurrence ----------

const DAY_MS = 86_400_000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const dayNumber = (d: string) => Date.parse(`${d}T00:00:00Z`) / DAY_MS;
const fromDayNumber = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => fromDayNumber(dayNumber(d) + n);

/** Month arithmetic the way Tasks (moment) does it: the 31st plus a month is the last day of a short month. */
function addMonths(d: string, n: number): string {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day, last));
  return first.toISOString().slice(0, 10);
}

/**
 * The date after `from` for a Tasks rule ("every week", "every 3 days", "every weekday", "every Monday, Thursday",
 * "every week on Friday"), or null for rules we don't understand, which then just tick off without a next one.
 */
export function nextDate(rule: string, from: string): string | null {
  const r = rule.toLowerCase().replace(/^every\s+/, "").trim();
  const unit = /^(?:(\d+)\s+)?(day|week|month|year)s?$/.exec(r);
  if (unit) {
    const n = Number(unit[1] ?? 1);
    if (n < 1) return null;
    if (unit[2] === "day") return addDays(from, n);
    if (unit[2] === "week") return addDays(from, 7 * n);
    return addMonths(from, unit[2] === "month" ? n : 12 * n);
  }
  const days =
    r === "weekday"
      ? [1, 2, 3, 4, 5]
      : /^(?:week\s+on\s+)?[a-z]+(?:\s*(?:,|and)\s*[a-z]+)*$/.test(r)
        ? r
            .replace(/^week\s+on\s+/, "")
            .split(/\s*(?:,|and)\s*/)
            .map((w) => WEEKDAYS.indexOf(w))
        : [];
  if (!days.length || days.includes(-1)) return null;
  for (let n = 1; n <= 7; n++) {
    const next = addDays(from, n);
    if (days.includes(new Date(`${next}T00:00:00Z`).getUTCDay())) return next;
  }
  return null;
}

/**
 * The next copy of a recurring task (`🔁 every week`), open again with its dates moved on, or null if it doesn't
 * recur. Like Tasks: the next date counts from the due date (else scheduled, else start), or from today with
 * "when done"; every other date on the line moves by the same number of days.
 */
export function nextOccurrence(raw: string, today: string): string | null {
  const m = TASK.exec(raw);
  if (!m) return null;
  const rest = m[4]!;
  const rule = /🔁\uFE0F?\s*([^📅⏳🛫✅➕❌⏫🔼🔽🔺⏬(^]*)/u.exec(rest)?.[1]?.trim();
  if (!rule) return null;
  const whenDone = /\s+when done$/i.test(rule);
  const base = [/📅\uFE0F?\s*(\d{4}-\d{2}-\d{2})/u, /⏳\uFE0F?\s*(\d{4}-\d{2}-\d{2})/u, /🛫\uFE0F?\s*(\d{4}-\d{2}-\d{2})/u]
    .map((re) => re.exec(rest)?.[1])
    .find(Boolean);
  const next = nextDate(rule.replace(/\s+when done$/i, ""), whenDone || !base ? today : base);
  if (!next) return null;
  const shift = base ? dayNumber(next) - dayNumber(base) : 0;
  const moved = rest
    .replace(new RegExp(String.raw`\s*[✅❌]\uFE0F?\s*${DATE}`, "gu"), "")
    .replace(new RegExp(String.raw`([📅⏳🛫]\uFE0F?\s*|\(@)(${DATE})`, "gu"), (_, mark: string, d: string) => mark + addDays(d, shift));
  return `${m[1]} ${m[3]}${moved}`;
}

type Row = Omit<Todo, "line"> & { line: number; path: string; note_title: string; mtime: number };

const toggleBody = z.object({
  path: z.string().min(1).max(1024),
  line: z.number().int().min(0),
  raw: z.string().max(10_000),
  done: z.boolean(),
  // Undoing a tick: the next copy of a recurring todo that tick added, to take back out.
  next: z.string().max(10_000).optional(),
});
const editBody = z.object({
  path: z.string().min(1).max(1024),
  line: z.number().int().min(0),
  raw: z.string().max(10_000),
  text: z.string().trim().min(1).max(2000).optional(),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  time: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(),
  status: z.enum(["open", "done", "cancelled"]).optional(),
});
const addBody = z.object({
  text: z.string().trim().min(1).max(2000),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  time: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
  path: z.string().max(1024).optional(),
  // Read a date, time or repeat off the end of the text ("call mum tomorrow 6pm") when none is given.
  natural: z.boolean().optional(),
});
const listQuery = z.object({ view: z.enum(["open", "done", "all"]).default("open") });

export function todoRoutes(db: Database, vault: Vault, timeZone: string) {
  const app = new Hono<AuthEnv>();
  const today = () => localIso(new Date(), timeZone).slice(0, 10);

  app.get("/todos", (c) => {
    const q = listQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid query" }, 400);
    const where = q.data.view === "open" ? "t.status = 'open'" : q.data.view === "done" ? "t.status != 'open'" : "1";
    // Open: dated first by date, then undated; within a day by priority, then newest note first.
    // Done: most recently finished first.
    const order =
      q.data.view === "open"
        ? "t.due IS NULL, t.due, t.priority, n.mtime DESC, t.path, t.line"
        : "t.done_on IS NULL, t.done_on DESC, n.mtime DESC, t.path, t.line";
    const rows = db
      .query<Row, []>(
        `SELECT t.path, t.line, t.raw, t.text, t.status, t.due, t.remind_at, t.done_on, t.priority, t.start, t.scheduled,
                n.title AS note_title, n.mtime
         FROM todos t JOIN notes n ON n.path = t.path WHERE ${where} ORDER BY ${order} LIMIT 500`,
      )
      .all();
    return c.json({ todos: rows, today: today() });
  });

  // For the Todos tab's badge: open todos that are overdue or due today and have started.
  app.get("/todos/count", (c) => {
    const t = today();
    const row = db
      .query<{ overdue: number; today: number }, [string, string, string]>(
        `SELECT COALESCE(SUM(due < ?1), 0) AS overdue, COALESCE(SUM(due = ?2), 0) AS today FROM todos
         WHERE status = 'open' AND due IS NOT NULL AND (start IS NULL OR start <= ?3)`,
      )
      .get(t, t, t);
    return c.json({ overdue: row?.overdue ?? 0, today: row?.today ?? 0 });
  });

  /**
   * Finds the line the client saw (where it was, or the same text alone elsewhere if the file moved on), lets `change`
   * rewrite the note's lines, and saves. `change` returns where the line ended up. Retries once if a save lands between
   * our read and write.
   */
  async function rewrite(path: string, line: number, raw: string, change: (lines: string[], at: number, cr: string) => number) {
    for (let attempt = 0; ; attempt++) {
      const note = await vault.read(path);
      const lines = note.content.split("\n");
      const strip = (l: string) => l.replace(/\r$/, "");
      let at = strip(lines[line] ?? "") === raw ? line : -1;
      if (at < 0) {
        const matches = lines.flatMap((l, i) => (strip(l) === raw ? [i] : []));
        if (matches.length !== 1) throw new VaultError(409, "todo changed; reload");
        at = matches[0]!;
      }
      at = change(lines, at, lines[at]!.endsWith("\r") ? "\r" : "");
      try {
        await vault.write(path, lines.join("\n"), note.hash);
        return { at, raw: strip(lines[at]!) };
      } catch (err) {
        if (err instanceof VaultError && err.status === 409 && attempt === 0) continue;
        throw err;
      }
    }
  }

  const fail = (c: Context<AuthEnv>, err: unknown) => {
    if (err instanceof VaultError) return c.json({ error: err.message }, err.status);
    throw err;
  };

  // Ticks one line. Ticking a recurring todo adds its next copy above it, as Tasks does.
  app.post("/todos/toggle", async (c) => {
    const body = toggleBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const { path, line, raw, done, next } = body.data;
    let added: string | null = null;
    try {
      const out = await rewrite(path, line, raw, (lines, at, cr) => {
        lines[at] = setDone(raw, done, today()) + cr;
        added = done && parseTodos(raw, timeZone)[0]?.status === "open" ? nextOccurrence(raw, today()) : null;
        if (added) {
          lines.splice(at, 0, added + cr);
          return at + 1;
        }
        if (!done && next && at > 0 && lines[at - 1]!.replace(/\r$/, "") === next) {
          lines.splice(at - 1, 1);
          return at - 1;
        }
        return at;
      });
      const text = parseTodos(out.raw, timeZone)[0]?.text ?? "";
      vault.emit({ type: done ? "todo.done" : "todo.undone", path, text, source: "sink" });
      return c.json({ ok: true, line: out.at, raw: out.raw, ...(added ? { next: added } : {}) });
    } catch (err) {
      return fail(c, err);
    }
  });

  // Changes a todo's text, due date or reminder time (null clears) or status (to cancel one), leaving the rest alone.
  app.post("/todos/edit", async (c) => {
    const body = editBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const { path, line, raw, ...change } = body.data;
    if (!TASK.test(raw)) return c.json({ error: "not a todo" }, 400);
    try {
      const out = await rewrite(path, line, raw, (lines, at, cr) => {
        const { status, ...fields } = change;
        const edited = editTodo(raw, fields);
        lines[at] = (status ? setStatus(edited, status, today()) : edited) + cr;
        return at;
      });
      return c.json({ ok: true, line: out.at, raw: out.raw });
    } catch (err) {
      return fail(c, err);
    }
  });

  // Quick todo: appended to Todo.md (or another note), created if missing.
  app.post("/todos", async (c) => {
    const body = addBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const { path = TODO_FILE, natural, ...given } = body.data;
    const { text, due, time, every }: { text: string; due?: string; time?: string; every?: string } =
      natural && !given.due ? parseQuick(given.text, today()) : given;
    const line = todoLine(text, due, time, every);
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
          return c.json({ ok: true, path: saved.path, line: content.split("\n").length - 2, raw: line, due: due ?? null, time: time ?? null }, 201);
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

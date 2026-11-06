import { Hono } from "hono";
import type { Auth } from "../auth";
import type { Space } from "../users";
import { localIso } from "../time";
import { REMINDER, repeatRule } from "../todos";

type Row = { path: string; raw: string; text: string; due: string | null; remind_at: number | null; note_title: string; mtime: number };

const FREQ = { day: "DAILY", week: "WEEKLY", month: "MONTHLY", year: "YEARLY" } as const;
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
// A todo with a reminder time has no length of its own; half an hour keeps it visible in a day view.
const EVENT_LENGTH = "PT30M";

const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

/** Text values escape backslash, semicolon, comma and newlines (RFC 5545 §3.3.11). */
const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Lines are at most 75 octets; longer ones continue on the next line after a space. Never splits a character. */
function fold(line: string) {
  const parts: string[] = [];
  let cur = "";
  let size = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (size + n > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = "";
      size = 0;
    }
    cur += ch;
    size += n;
  }
  return [...parts, cur].join("\r\n ");
}

/** A Tasks rule as an RRULE, or null for the ones that can't be written as one ("when done", the 31st of each month). */
function rrule(raw: string, due: string): string | null {
  const r = repeatRule(raw)?.toLowerCase().replace(/^every\s+/, "");
  if (!r) return null;
  const unit = /^(?:(\d+)\s+)?(day|week|month|year)s?$/.exec(r);
  if (unit) {
    // Tasks clamps to the month's last day; RRULE would skip short months.
    if (unit[2]! in { month: 1, year: 1 } && Number(due.slice(8)) > 28) return null;
    return `FREQ=${FREQ[unit[2] as keyof typeof FREQ]}${Number(unit[1]) > 1 ? `;INTERVAL=${unit[1]}` : ""}`;
  }
  const days =
    r === "weekday"
      ? [1, 2, 3, 4, 5]
      : r
          .replace(/^week\s+on\s+/, "")
          .split(/\s*(?:,|and)\s*/)
          .map((w) => DAYS.indexOf(w));
  if (days.includes(-1)) return null;
  return `FREQ=WEEKLY;BYDAY=${days.map((d) => DAYS[d]!.slice(0, 2).toUpperCase()).join(",")}`;
}

/** Open todos with a date or reminder as an iCalendar feed: all-day events, or timed ones (with an alarm) when they have a reminder time. */
export function icsFeed(rows: Row[], timeZone: string): string {
  const stamp = (ms: number) => localIso(new Date(ms), timeZone).slice(0, 19).replace(/[-:]/g, "");
  const at = (name: string, ms: number) => (timeZone === "UTC" ? `${name}:${stamp(ms)}Z` : `${name};TZID=${timeZone}:${stamp(ms)}`);
  const seen = new Map<string, number>();
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sink//Todos//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Sink todos", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"];
  if (timeZone !== "UTC") lines.push(`X-WR-TIMEZONE:${timeZone}`);
  for (const t of rows) {
    // Lines move when a note is edited, so the id comes from where the todo lives and what it says; dates stay out of it
    // so moving one updates its event. Identical todos in one note get a counter.
    const key = sha(`${t.path}\n${t.text}`).slice(0, 24);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    const reminder = REMINDER.exec(t.raw);
    const timed = !!reminder?.[2] && t.remind_at !== null;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${key}${n ? `-${n}` : ""}@sink`,
      `DTSTAMP:${new Date(t.mtime).toISOString().replace(/[-:]|\.\d{3}/g, "")}`,
      ...(timed ? [at("DTSTART", t.remind_at!), `DURATION:${EVENT_LENGTH}`] : [`DTSTART;VALUE=DATE:${t.due!.replaceAll("-", "")}`]),
      `SUMMARY:${escape(t.text)}`,
      `DESCRIPTION:${escape(`From ${t.note_title}`)}`,
    );
    const rule = rrule(t.raw, timed ? reminder![1]! : t.due!);
    if (rule) lines.push(`RRULE:${rule}`);
    if (timed) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escape(t.text)}`, "TRIGGER:PT0S", "END:VALARM");
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/**
 * The private feed calendar apps subscribe to: /api/calendar/<token>.ics. The token (a `calendar`-scope token, which
 * nothing else accepts) picks the account and so its vault; anything else is a plain 404.
 */
export function calendarRoutes(auth: Auth, spaceOf: (subject: string) => Space, timeZone: string) {
  const app = new Hono();
  app.get("/:file{.+\\.ics}", (c) => {
    const subject = auth.calendarSubject(c.req.param("file").slice(0, -4));
    if (subject === null) return c.json({ error: "not found" }, 404);
    const rows = spaceOf(subject)
      .db.query<Row, []>(
        `SELECT t.path, t.raw, t.text, t.due, t.remind_at, n.title AS note_title, n.mtime
         FROM todos t JOIN notes n ON n.path = t.path
         WHERE t.status = 'open' AND (t.due IS NOT NULL OR t.remind_at IS NOT NULL) ORDER BY t.path, t.line`,
      )
      .all();
    return c.body(icsFeed(rows, timeZone), 200, {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
    });
  });
  return app;
}

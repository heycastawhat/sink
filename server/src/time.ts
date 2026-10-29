/** The user's wall clock: notes, todos and emails are dated in their zone, not the container's (UTC). */

export function utcOffset(at: Date, timeZone: string): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = name?.match(/GMT([+-]\d{2}:\d{2})/);
  return m ? m[1]! : "+00:00";
}

/** Local ISO time with offset, e.g. 2026-10-29T17:12:00+13:00. */
export function localIso(at: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${utcOffset(at, timeZone)}`;
}

/**
 * Epoch ms for a date or date-time the user wrote. Date-only ("2026-10-30") means 9am that day;
 * a time with no zone is the user's local time.
 */
export function localTime(raw: string, timeZone: string): number | null {
  let value = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T09:00:00` : raw;
  if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value)) {
    const guess = Date.parse(`${value}Z`);
    if (Number.isNaN(guess)) return null;
    value += utcOffset(new Date(guess), timeZone);
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

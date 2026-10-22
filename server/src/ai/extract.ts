import { z } from "zod";

export const KINDS = [
  "event",
  "receipt",
  "product",
  "place",
  "code",
  "article",
  "message",
  "recipe",
  "other",
] as const;

export const ACTION_TYPES = ["reminder", "calendar", "todo", "open_url", "copy"] as const;

const stringList = z.array(z.coerce.string()).catch([]);

// Lenient: free models drift from the schema, so anything malformed falls back to a default.
export const extractionSchema = z.object({
  kind: z.enum(KINDS).catch("other"),
  title: z.coerce.string().max(200).catch("Untitled"),
  summary: z.coerce.string().max(1000).catch(""),
  tags: stringList.transform((t) => [...new Set(t.map((s) => s.toLowerCase().trim()).filter(Boolean))].slice(0, 8)),
  entities: z
    .object({
      dates: stringList,
      urls: stringList,
      prices: stringList,
      addresses: stringList,
      people: stringList,
    })
    .partial()
    .catch({}),
  actions: z
    .array(
      z.object({
        type: z.enum(ACTION_TYPES),
        label: z.coerce.string().max(120),
        payload: z.record(z.string(), z.unknown()).catch({}),
      }),
    )
    .catch([])
    .transform((a) => a.slice(0, 5)),
});

export type Extraction = z.infer<typeof extractionSchema>;

export type ExtractInput = {
  imageDataUrl: string;
  note?: string | null;
  ocrText?: string | null;
  appPackage?: string | null;
  sourceUrl?: string | null;
  capturedAt: Date;
  timeZone: string;
};

export const SYSTEM_PROMPT = `You file screenshots into a personal "sink" so the user can find them later and act on them.
Look at the screenshot, the text on screen and the user's note (the note says WHY they saved it and matters most).
Reply with ONLY a JSON object, no prose, no code fences:
{
  "kind": one of ${KINDS.map((k) => `"${k}"`).join(", ")},
  "title": short specific title, max 8 words,
  "summary": 1-2 sentences of what this is and why it might matter,
  "tags": up to 6 lowercase tags,
  "entities": { "dates": [ISO 8601 with the user's UTC offset, e.g. 2026-11-07T07:05:00+13:00; date-only if no time], "urls": [], "prices": [], "addresses": [], "people": [] },
  "actions": up to 3 of {
    "type": one of ${ACTION_TYPES.map((k) => `"${k}"`).join(", ")},
    "label": button text,
    "payload": calendar: {"title","start","end","location"}; reminder/todo: {"text","due"}; open_url: {"url"}; copy: {"text"}
  }
}
Rules:
- Times are in the user's timezone (given below). Write every date/time with that UTC offset.
- Resolve relative dates ("Friday", "tomorrow") against the capture time. Never invent a date or time the screenshot and note don't give or clearly imply; leave it out instead.
- Only suggest actions that are clearly useful to the user in real life. Never suggest actions about the phone or app UI itself (popups, notifications, buttons, dismissing things).
- "reminder" pings the user's phone, so be sparing: at most ONE per screenshot, only when the screenshot shows a real deadline or time-sensitive moment (tickets on sale, a booking, a flight, a bill due, a delivery window). Its "due" is when to ping, e.g. a bit before the deadline. No reminder for articles, reading, general info, or anything without a clear date.
- "calendar" for something with a start time the user attends; "todo" for an undated task.
- If you only know the day, give a date with no time (YYYY-MM-DD); never make up midnight or other times.
- Omit unknown fields.`;

export function buildUserText(input: ExtractInput): string {
  const parts = [
    `User's timezone: ${input.timeZone} (UTC${utcOffset(input.capturedAt, input.timeZone)})`,
    `Captured at: ${localIso(input.capturedAt, input.timeZone)}`,
  ];
  if (input.appPackage) parts.push(`Source app: ${input.appPackage}`);
  if (input.sourceUrl) parts.push(`Page URL: ${input.sourceUrl}`);
  if (input.note) parts.push(`User note: ${input.note}`);
  if (input.ocrText) parts.push(`Text on screen:\n${input.ocrText.slice(0, 8000)}`);
  return parts.join("\n\n");
}

/** Pulls the first JSON object out of a model reply, tolerating code fences and chatter. */
export function parseExtraction(raw: string): Extraction {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in model reply");
  const json = JSON.parse(raw.slice(start, end + 1));
  return extractionSchema.parse(json);
}

/** "+13:00" style offset of a zone at a given instant. */
export function utcOffset(at: Date, timeZone: string): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = name?.match(/GMT([+-]\d{2}:\d{2})/);
  return m ? m[1]! : "+00:00";
}

/** Local wall-clock ISO string with offset, e.g. 2026-10-22T17:12:00+13:00 (Friday). */
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
      weekday: "long",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${utcOffset(at, timeZone)} (${parts.weekday})`;
}

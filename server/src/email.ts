import type { Database } from "bun:sqlite";
import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject, type Attachment, type ParsedMail } from "mailparser";
import type { Config } from "./config";
import { pageText } from "./html";
import { localIso } from "./time";
import { VaultError, type Vault } from "./notes";

/**
 * Email in: mail forwarded to a dedicated mailbox lands in Sink. IMAP IDLE watches the mailbox; each message is
 * checked (allowlisted sender, DKIM/SPF aligned with From), routed by plus-address, then moved out of the inbox.
 *
 *   sink+todo@…  -> "- [ ] subject" appended to Todo.md
 *   sink@…       -> markdown note in Inbox/ (attachments saved and embedded)
 */

export type ImapConfig = Config["imap"];

export type Outcome =
  | { kind: "note"; path: string }
  | { kind: "todo"; path: string }
  | { kind: "rejected"; reason: string }
  // Sink or the NAS is down: leave the message where it is and try again later.
  | { kind: "retry"; reason: string };

export type HandlerDeps = {
  vault: Vault;
  allowedFrom: string[];
  // The receiving mail server's id in Authentication-Results (e.g. "mx.google.com"); empty trusts the top header.
  authservId?: string;
  timeZone: string;
  maxUploadBytes: number;
};

const BODY_MAX_CHARS = 50_000;
const NOTE_FOLDER = "Inbox";
const TODO_FILE = "Todo.md";

// ---- checks

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase().replace(/[>\s]+$/, "");

/** Relaxed DMARC-style alignment: same domain, or one is a subdomain of the other. */
export function aligned(a: string, b: string): boolean {
  a = a.toLowerCase().replace(/\.$/, "");
  b = b.toLowerCase().replace(/\.$/, "");
  return a === b || a.endsWith("." + b) || b.endsWith("." + a);
}

/** Entries are full addresses or `@domain`; an empty list lets nothing in. */
export function senderAllowed(from: string, allowed: string[]): boolean {
  const addr = from.toLowerCase();
  return allowed.some((rule) => {
    const r = rule.trim().toLowerCase();
    if (!r) return false;
    return r.startsWith("@") ? domainOf(addr) === r.slice(1) : addr === r;
  });
}

export type AuthResult = { method: string; result: string; domain: string | null };

/**
 * Reads one Authentication-Results header: `authserv-id; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=…`.
 * Comments in parentheses and quoting are tolerated; unknown methods are kept but never trusted.
 */
export function parseAuthResults(header: string): AuthResult[] {
  const unfolded = header.replace(/\r?\n[ \t]+/g, " ").replace(/\([^()]*\)/g, " ");
  const [, ...parts] = unfolded.split(";");
  const out: AuthResult[] = [];
  for (const part of parts) {
    const m = /^\s*([a-z0-9-]+)\s*=\s*([a-z]+)/i.exec(part);
    if (!m) continue;
    const method = m[1]!.toLowerCase();
    const props = Object.fromEntries(
      [...part.matchAll(/([a-z]+\.[a-z0-9-]+)\s*=\s*"?([^\s";]+)"?/gi)].map((p) => [p[1]!.toLowerCase(), p[2]!]),
    );
    const raw =
      method === "dkim"
        ? (props["header.d"] ?? props["header.i"])
        : method === "spf"
          ? (props["smtp.mailfrom"] ?? props["smtp.helo"])
          : method === "dmarc"
            ? props["header.from"]
            : undefined;
    out.push({ method, result: m[2]!.toLowerCase(), domain: raw ? domainOf(raw) : null });
  }
  return out;
}

/** True when the receiving server vouched for the From domain: aligned DKIM or SPF pass, or DMARC pass. */
export function authenticated(results: AuthResult[], fromDomain: string): boolean {
  return results.some(
    (r) => r.result === "pass" && r.domain !== null && ["dkim", "spf", "dmarc"].includes(r.method) && aligned(r.domain, fromDomain),
  );
}

// ---- reading the message

/** Raw header values in order, top first (mailparser merges duplicates in `headers`). */
function headerValues(mail: ParsedMail, name: string): string[] {
  return mail.headerLines
    .filter((h) => h.key === name)
    .map((h) => h.line.slice(h.line.indexOf(":") + 1).trim());
}

const addressesIn = (value: string) => [...value.matchAll(/[^\s<>,;"']+@[^\s<>,;"']+/g)].map((m) => m[0].toLowerCase());

/** The `+tag` on whichever of our addresses the message was sent to. */
export function plusTag(mail: ParsedMail): string | null {
  const values = ["to", "cc", "delivered-to", "x-original-to"].flatMap((h) => headerValues(mail, h));
  for (const addr of values.flatMap(addressesIn)) {
    const local = addr.slice(0, addr.lastIndexOf("@"));
    const plus = local.indexOf("+");
    if (plus >= 0) return local.slice(plus + 1);
  }
  return null;
}

const firstAddress = (a: AddressObject | AddressObject[] | undefined) => (Array.isArray(a) ? a[0] : a)?.value[0];

export const cleanSubject = (s: string | undefined) => (s ?? "").replace(/^\s*((fwd?|fw|re)\s*:\s*)+/i, "").trim();

const FORWARD_MARKER = /^[ \t>]*(-{2,}\s*(Forwarded message|Original Message)\s*-{2,}|Begin forwarded message:)[ \t]*$/im;

/**
 * Forwarding wraps the real content in a marker and a From/Date/Subject/To block. The forwarded body is the content,
 * so drop the wrapper but keep who it was originally from as one line.
 */
export function unwrapForward(text: string): { text: string; originalSubject: string | null } {
  const m = FORWARD_MARKER.exec(text);
  if (!m) return { text: text.trim(), originalSubject: null };
  const before = text.slice(0, m.index).trim();
  const lines = text.slice(m.index + m[0].length).replace(/^\r?\n/, "").split(/\r?\n/);
  const header: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const h = /^[ \t>]*(From|Date|Sent|Subject|To|Cc|Reply-To)\s*:\s*(.*)$/i.exec(lines[i]!);
    if (h) header[h[1]!.toLowerCase()] = h[2]!.trim();
    else if (lines[i]!.trim() === "" && Object.keys(header).length) {
      i++;
      break;
    } else if (lines[i]!.trim() !== "") break;
  }
  const body = lines.slice(i).join("\n").trim();
  const parts = [before, header.from ? `Forwarded from ${header.from}` : "", body].filter(Boolean);
  return { text: parts.join("\n\n"), originalSubject: header.subject ? cleanSubject(header.subject) : null };
}

function bodyText(mail: ParsedMail): string {
  const text = mail.text?.trim() || (typeof mail.html === "string" ? pageText(mail.html).replace(/^Title: .*\n*/, "") : "");
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").slice(0, BODY_MAX_CHARS);
}

const isImage = (a: Attachment) => a.contentType.startsWith("image/");
const yamlString = (s: string) => JSON.stringify(s);

// ---- handling one message

/** Checks, routes and files one raw RFC822 message. Never throws for bad mail; transient failures return retry. */
export async function handleMessage(source: Buffer | string, deps: HandlerDeps): Promise<Outcome> {
  const mail = await simpleParser(source);
  const from = firstAddress(mail.from);
  if (!from?.address) return { kind: "rejected", reason: "no From address" };
  const sender = from.address.toLowerCase();
  if (!senderAllowed(sender, deps.allowedFrom)) return { kind: "rejected", reason: `sender ${sender} not allowed` };
  // The receiving server adds its header on top; anything below could have come from the sender.
  // With an authserv-id configured, only results stamped by that server count: a mail host that adds no header of
  // its own would otherwise leave the sender's forged one on top.
  const results = headerValues(mail, "authentication-results");
  const servId = (h: string) => h.replace(/\r?\n[ \t]+/g, " ").split(";")[0]!.trim().split(/\s+/)[0]!.toLowerCase();
  const [topAuth] = deps.authservId ? results.filter((h) => servId(h) === deps.authservId!.toLowerCase()) : results;
  if (!topAuth || !authenticated(parseAuthResults(topAuth), domainOf(sender))) {
    return { kind: "rejected", reason: `no aligned DKIM/SPF pass for ${domainOf(sender)}` };
  }

  const { text, originalSubject } = unwrapForward(bodyText(mail));
  const subject = cleanSubject(mail.subject) || originalSubject || text.split("\n")[0]!.slice(0, 120).trim() || "Email";
  const attachments = mail.attachments.filter((a) => a.size <= deps.maxUploadBytes);
  if (attachments.length < mail.attachments.length) console.warn(`[email] skipped ${mail.attachments.length - attachments.length} oversized attachment(s)`);
  const tag = plusTag(mail)?.toLowerCase();

  try {
    if (tag === "todo") {
      const line = `- [ ] ${subject.replace(/\s+/g, " ")}\n`;
      for (let attempt = 0; ; attempt++) {
        try {
          const current = await deps.vault.read(TODO_FILE).catch((err) => {
            if (err instanceof VaultError && err.status === 404) return null;
            throw err;
          });
          const content = current ? current.content.replace(/\n*$/, "\n") + line : `# Todo\n\n${line}`;
          await deps.vault.write(TODO_FILE, content, current?.hash ?? null);
          return { kind: "todo", path: TODO_FILE };
        } catch (err) {
          // Someone saved Todo.md in between: read it again and append once more.
          if (attempt === 0 && err instanceof VaultError && err.status === 409) continue;
          throw err;
        }
      }
    }

    // Anything else (no tag, or +note) becomes a note.
    const embeds: string[] = [];
    for (const a of attachments) {
      const path = await deps.vault.saveAttachment(a.filename || `attachment${isImage(a) ? "." + a.contentType.split("/")[1] : ""}`, new Uint8Array(a.content));
      embeds.push(`![[${path.split("/").pop()}]]`);
    }
    const date = mail.date ?? new Date();
    const content = [
      ["---", `from: ${yamlString(from.name ? `${from.name} <${sender}>` : sender)}`, `date: ${localIso(date, deps.timeZone)}`, "source: email", "---"].join("\n"),
      `# ${subject}`,
      text,
      embeds.join("\n"),
    ]
      .filter(Boolean)
      .join("\n\n") + "\n";
    const note = await deps.vault.create(NOTE_FOLDER, subject, content);
    return { kind: "note", path: note.path };
  } catch (err) {
    if (err instanceof VaultError && err.status !== 503) return { kind: "rejected", reason: err.message };
    return { kind: "retry", reason: (err as Error).message };
  }
}

// ---- the mailbox watcher


export class EmailIngest {
  private client: ImapFlow | null = null;
  private running = false;
  private draining: Promise<void> | null = null;
  private again = false;
  /** Message-IDs already filed, in case moving them out of the inbox failed. Kept in the database when given one. */
  private done = new Set<string>();
  private retries = new Map<number, number>();

  constructor(
    private config: ImapConfig,
    private deps: HandlerDeps,
    private db?: Database,
  ) {}

  private isDone(messageId: string): boolean {
    if (this.done.has(messageId)) return true;
    return !!this.db?.query("SELECT 1 FROM email_seen WHERE message_id = ?").get(messageId);
  }

  private markDone(messageId: string) {
    this.done.add(messageId);
    this.db?.query("INSERT OR IGNORE INTO email_seen (message_id, at) VALUES (?, ?)").run(messageId, Date.now());
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  async stop() {
    this.running = false;
    await this.client?.logout().catch(() => {});
  }

  private async loop() {
    let backoff = 5_000;
    while (this.running) {
      const client = new ImapFlow({
        host: this.config.host,
        port: this.config.port,
        secure: this.config.secure,
        auth: { user: this.config.user, pass: this.config.password },
        logger: false,
      });
      this.client = client;
      client.on("error", (err: Error) => console.warn(`[email] ${err.message}`));
      const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
      try {
        await client.connect();
        for (const folder of [this.config.processedFolder, this.config.rejectedFolder]) {
          // Already-exists is fine; anything else shows up when the move fails.
          await client.mailboxCreate(folder).catch(() => {});
        }
        await client.mailboxOpen(this.config.mailbox);
        console.log(`[email] watching ${this.config.user}/${this.config.mailbox}`);
        backoff = 5_000;
        client.on("exists", () => this.kick(client));
        await this.kick(client);
        // Retry anything that failed transiently, without waiting for new mail.
        const timer = setInterval(() => this.retries.size && this.kick(client), 5 * 60_000);
        await closed;
        clearInterval(timer);
      } catch (err) {
        console.warn(`[email] connection failed: ${(err as Error).message}`);
        await client.logout().catch(() => {});
      }
      if (!this.running) break;
      console.warn(`[email] disconnected; reconnecting in ${Math.round(backoff / 1000)}s`);
      await Bun.sleep(backoff);
      backoff = Math.min(backoff * 2, 5 * 60_000);
    }
  }

  /** Drains unseen mail; a kick while draining runs one more pass afterwards. */
  private kick(client: ImapFlow): Promise<void> {
    if (this.draining) {
      this.again = true;
      return this.draining;
    }
    this.draining = (async () => {
      do {
        this.again = false;
        await this.drain(client).catch((err) => console.warn(`[email] drain failed: ${(err as Error).message}`));
      } while (this.again && this.running);
    })().finally(() => (this.draining = null));
    return this.draining;
  }

  private async drain(client: ImapFlow) {
    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    for (const uid of uids) {
      const msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
      if (!msg || !msg.source) continue;
      const messageId = msg.envelope?.messageId ?? `uid:${uid}`;
      let outcome: Outcome;
      if (this.isDone(messageId)) outcome = { kind: "rejected", reason: "already handled" };
      else {
        try {
          outcome = await handleMessage(msg.source, this.deps);
        } catch (err) {
          outcome = { kind: "rejected", reason: `unreadable: ${(err as Error).message}` };
        }
      }
      if (outcome.kind === "retry") {
        const n = (this.retries.get(uid) ?? 0) + 1;
        this.retries.set(uid, n);
        console.warn(`[email] ${messageId}: will retry (${outcome.reason}), attempt ${n}`);
        continue;
      }
      this.retries.delete(uid);
      const repeat = outcome.kind === "rejected" && outcome.reason === "already handled";
      if (!repeat) console.log(`[email] ${messageId}: ${outcome.kind === "rejected" ? `rejected (${outcome.reason})` : outcome.kind}`);
      if (outcome.kind !== "rejected") this.markDone(messageId);
      const folder = outcome.kind === "rejected" && !repeat ? this.config.rejectedFolder : this.config.processedFolder;
      const moved = await client.messageMove(String(uid), folder, { uid: true }).catch(() => false);
      // Couldn't move: at least mark it read so the next pass skips it.
      if (!moved) await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }).catch(() => {});
    }
  }
}

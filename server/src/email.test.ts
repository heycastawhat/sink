import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { Vault, VaultError } from "./notes";
import {
  aligned,
  authenticated,
  handleMessage,
  parseAuthResults,
  senderAllowed,
  unwrapForward,
  type HandlerDeps,
} from "./email";

const PASS = "mx.sink.test; dkim=pass header.d=example.com header.s=s1; spf=pass (sender ok) smtp.mailfrom=sam@example.com";

/** A raw RFC822 message; `parts` makes it multipart with attachments. */
function mail(opts: {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  html?: string;
  auth?: string[];
  messageId?: string;
  attachments?: { name: string; type: string; data: Buffer }[];
  extra?: string[];
}): string {
  const headers = [
    ...(opts.auth ?? [PASS]).map((a) => `Authentication-Results: ${a}`),
    `From: ${opts.from ?? "Sam <sam@example.com>"}`,
    `To: ${opts.to ?? "sink@mail.test"}`,
    `Subject: ${opts.subject ?? "Hello"}`,
    `Date: Thu, 29 Oct 2026 10:00:00 +1300`,
    `Message-ID: ${opts.messageId ?? "<abc123@example.com>"}`,
    "MIME-Version: 1.0",
    ...(opts.extra ?? []),
  ];
  const textPart = opts.html
    ? `Content-Type: text/html; charset=utf-8\r\n\r\n${opts.html}`
    : `Content-Type: text/plain; charset=utf-8\r\n\r\n${opts.body ?? "Body text"}`;
  if (!opts.attachments?.length) return [...headers, textPart].join("\r\n") + "\r\n";
  const b = "BOUNDARY42";
  const parts = [
    `--${b}\r\n${textPart}`,
    ...opts.attachments.map(
      (a) =>
        `--${b}\r\nContent-Type: ${a.type}; name="${a.name}"\r\nContent-Disposition: attachment; filename="${a.name}"\r\n` +
        `Content-Transfer-Encoding: base64\r\n\r\n${a.data.toString("base64")}`,
    ),
    `--${b}--`,
  ];
  return [...headers, `Content-Type: multipart/mixed; boundary="${b}"`, "", parts.join("\r\n")].join("\r\n") + "\r\n";
}

let dir: string;
let deps: HandlerDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sink-email-"));
  deps = { vault: new Vault(openDb(":memory:"), dir), allowedFrom: ["sam@example.com"], timeZone: "America/New_York", maxUploadBytes: 1024 * 1024 };
});

const note = (path: string) => readFileSync(join(dir, path), "utf8");

describe("email security", () => {
  test("sender allowlist: addresses, @domains, empty fails closed", () => {
    expect(senderAllowed("sam@example.com", ["SAM@example.com"])).toBe(true);
    expect(senderAllowed("other@example.com", ["@example.com"])).toBe(true);
    expect(senderAllowed("sam@evil.com", ["@example.com", "sam@example.com"])).toBe(false);
    expect(senderAllowed("sam@example.com", [])).toBe(false);
  });

  test("authentication-results parsing and alignment", () => {
    const r = parseAuthResults(PASS);
    expect(r).toEqual([
      { method: "dkim", result: "pass", domain: "example.com" },
      { method: "spf", result: "pass", domain: "example.com" },
    ]);
    expect(authenticated(r, "example.com")).toBe(true);
    expect(authenticated(r, "mail.example.com")).toBe(true);
    expect(authenticated(parseAuthResults("mx; dkim=pass header.d=evil.com; spf=fail smtp.mailfrom=example.com"), "example.com")).toBe(false);
    expect(authenticated(parseAuthResults("mx; dmarc=pass (p=none) header.from=example.com"), "example.com")).toBe(true);
    expect(authenticated(parseAuthResults("garbage"), "example.com")).toBe(false);
    expect(aligned("notexample.com", "example.com")).toBe(false);
  });

  test("rejects unknown senders, failed or misaligned auth, and only trusts the top header", async () => {
    expect(await handleMessage(mail({ from: "x@evil.com" }), deps)).toMatchObject({ kind: "rejected", reason: expect.stringContaining("not allowed") });
    const failed = mail({ auth: ["mx; dkim=fail header.d=example.com; spf=softfail smtp.mailfrom=example.com"] });
    expect((await handleMessage(failed, deps)).kind).toBe("rejected");
    const misaligned = mail({ auth: ["mx; dkim=pass header.d=bulkmailer.com; spf=pass smtp.mailfrom=bounce@bulkmailer.com"] });
    expect((await handleMessage(misaligned, deps)).kind).toBe("rejected");
    expect((await handleMessage(mail({ auth: [] }), deps)).kind).toBe("rejected");
    // A forged pass below the receiving server's fail doesn't count.
    const forged = mail({ auth: ["mx; dkim=none; spf=fail smtp.mailfrom=example.com", PASS] });
    expect((await handleMessage(forged, deps)).kind).toBe("rejected");
    // Nothing rejected was written to the vault.
    expect(existsSync(join(dir, "Inbox"))).toBe(false);
  });
});

describe("email routing", () => {
  test("+note makes a note in Inbox/ with frontmatter and embedded attachments", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const out = await handleMessage(
      mail({
        to: "Sink <sink+note@mail.test>",
        subject: "Fwd: Wifi details",
        body: "Network: Cabin\nPassword: hunter2",
        attachments: [
          { name: "router.png", type: "image/png", data: png },
          { name: "huge.bin", type: "application/octet-stream", data: Buffer.alloc(2 * 1024 * 1024) },
        ],
      }),
      deps,
    );
    expect(out).toEqual({ kind: "note", path: "Inbox/Wifi details.md" });
    const md = readFileSync(join(dir, "Inbox/Wifi details.md"), "utf8");
    expect(md).toStartWith('---\nfrom: "Sam <sam@example.com>"\ndate: 2026-10-28T17:00:00-04:00');
    expect(md).toContain("source: email\n---\n\n# Wifi details\n\nNetwork: Cabin\nPassword: hunter2\n\n![[router.png]]\n");
    expect(existsSync(join(dir, "attachments/router.png"))).toBe(true);
    expect(existsSync(join(dir, "attachments/huge.bin"))).toBe(false);
  });

  test("+todo appends to Todo.md, creating it first", async () => {
    expect(await handleMessage(mail({ to: "sink+todo@mail.test", subject: "Renew rego" }), deps)).toEqual({ kind: "todo", path: "Todo.md" });
    expect(readFileSync(join(dir, "Todo.md"), "utf8")).toBe("# Todo\n\n- [ ] Renew rego\n");
    writeFileSync(join(dir, "Todo.md"), "# Todo\n\n- [ ] Renew rego\n- [x] done thing");
    await handleMessage(mail({ extra: ["Delivered-To: sink+TODO@mail.test"], subject: "Book dentist", messageId: "<2@x>" }), deps);
    expect(readFileSync(join(dir, "Todo.md"), "utf8")).toBe("# Todo\n\n- [ ] Renew rego\n- [x] done thing\n- [ ] Book dentist\n");
  });

  test("plain address is a note too, attachments and all", async () => {
    const jpg = Buffer.from("ffd8ffe000104a464946", "hex");
    const out = await handleMessage(
      mail({ subject: "Concert tickets", body: "Main stage, Saturday 8pm", attachments: [{ name: "ticket.jpg", type: "image/jpeg", data: jpg }] }),
      deps,
    );
    expect(out).toEqual({ kind: "note", path: "Inbox/Concert tickets.md" });
    expect(note("Inbox/Concert tickets.md")).toContain("# Concert tickets\n\nMain stage, Saturday 8pm\n\n![[ticket.jpg]]\n");
  });

  test("HTML-only mail is read as text", async () => {
    const out = await handleMessage(mail({ html: "<html><body><p>Hello <b>there</b></p><p>Second para</p><script>x()</script></body></html>" }), deps);
    const text = note((out as { path: string }).path);
    expect(text).toContain("Hello there\n\nSecond para");
    expect(text).not.toContain("x()");
  });

  test("forward wrappers are unwrapped, content kept", async () => {
    const body = "FYI\n\n---------- Forwarded message ---------\nFrom: Example Air <noreply@air.example>\nDate: Wed, 28 Oct 2026\nSubject: Your booking EX123\nTo: <sam@example.com>\n\nFlight EX123 departs 7am.";
    expect(unwrapForward(body)).toEqual({
      text: "FYI\n\nForwarded from Example Air <noreply@air.example>\n\nFlight EX123 departs 7am.",
      originalSubject: "Your booking EX123",
    });
    const out = await handleMessage(mail({ subject: "Fwd:", body }), deps);
    expect(out).toEqual({ kind: "note", path: "Inbox/Your booking EX123.md" });
    expect(note("Inbox/Your booking EX123.md")).toContain("# Your booking EX123\n\nFYI");
  });

  test("with an authserv-id, only that server's results count", async () => {
    const pinned = { ...deps, authservId: "mx.sink.test" };
    // Mail host added nothing; the sender's own forged pass sits on top.
    const forged = mail({ auth: ["mx.attacker.test; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=sam@example.com"] });
    expect((await handleMessage(forged, pinned)).kind).toBe("rejected");
    // The real server's verdict counts even when a forged header sits above it.
    const real = mail({ auth: ["mx.attacker.test; dkim=pass header.d=example.com", PASS], messageId: "<real@x>" });
    expect((await handleMessage(real, pinned)).kind).toBe("note");
  });

  test("NAS down: the message stays for a retry", async () => {
    const vault = {
      create: async () => {
        throw new VaultError(503, "notes storage unavailable");
      },
    } as unknown as Vault;
    expect((await handleMessage(mail({}), { ...deps, vault })).kind).toBe("retry");
  });
});

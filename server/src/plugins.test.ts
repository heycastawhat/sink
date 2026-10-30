import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { Auth } from "./auth";
import { Oidc } from "./oidc";
import { Vault, type VaultEvent } from "./notes";
import { PluginHost, type BuiltinPlugin } from "./plugins";
import { createApp } from "./app";
import { daily } from "./builtin/daily";
import { webhooksPlugin } from "./builtin/webhooks";
import { localIso } from "./time";

const PUBLIC = "https://sink.test";

function writePlugin(root: string, id: string, files: Record<string, string>) {
  mkdirSync(join(root, id), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, id, name), body);
}

async function setup(opts: { builtins?: BuiltinPlugin[]; env?: Record<string, string>; disabled?: string[]; plugins?: (dir: string) => void } = {}) {
  const db = openDb(":memory:");
  const vaultDir = mkdtempSync(join(tmpdir(), "sink-vault-"));
  const pluginsDir = mkdtempSync(join(tmpdir(), "sink-plugins-"));
  opts.plugins?.(pluginsDir);
  const vault = new Vault(db, vaultDir, "UTC");
  const host = new PluginHost(vault, { timeZone: "UTC", dir: pluginsDir, disabled: opts.disabled, env: opts.env ?? {} });
  await host.load(opts.builtins ?? []);
  const auth = new Auth(db);
  const oidc = new Oidc({ issuer: "https://auth.test/", clientId: "x", clientSecret: "", allowedUsers: [], allowedGroups: [], allowAnyone: true });
  const app = createApp({
    db,
    vault,
    plugins: host,
    auth,
    oidc,
    config: { secureCookies: false, maxUploadBytes: 1024 * 1024, webDir: undefined, publicUrls: [PUBLIC], timeZone: "UTC" },
  });
  const token = auth.issueToken("test", "me");
  const req = (method: string, path: string, body?: unknown, tok = token) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { db, vault, vaultDir, host, app, auth, token, req };
}

const HELLO_SERVER = `
export default function setup(sink) {
  const seen = [];
  sink.on((e) => { seen.push(e.type + " " + e.path); });
  sink.routes.get("/seen", (c) => c.json({ seen, greeting: sink.env("GREETING", "hi") }));
  sink.mcpTool("shout", { description: "Shout text", inputSchema: {} }, async () => "HELLO");
}
`;

describe("plugin host", () => {
  test("loads a plugin folder: routes, events, settings, client files, assistant tools", async () => {
    const s = await setup({
      env: { SINK_PLUGIN_HELLO_GREETING: "kia ora" },
      plugins: (dir) =>
        writePlugin(dir, "hello", {
          "plugin.json": JSON.stringify({ id: "hello", name: "Hello", version: "1.0.0", server: "server.ts", client: "client.js", styles: "styles.css" }),
          "server.ts": HELLO_SERVER,
          "client.js": "export default (sink) => sink.command({ id: 'hi', name: 'Say hi', run: (ctx) => ctx.insert('hi') });",
          "styles.css": ".hello { color: red }",
        }),
    });
    const list = ((await (await s.req("GET", "/api/plugins")).json()) as any).plugins;
    expect(list).toEqual([
      expect.objectContaining({ id: "hello", builtin: false, client: "/plugins/hello/client.js", styles: "/plugins/hello/styles.css" }),
    ]);

    await s.req("POST", "/api/notes", { title: "One", content: "# One" });
    await new Promise((r) => setTimeout(r, 10));
    const seen = (await (await s.req("GET", "/api/plugins/hello/seen")).json()) as any;
    expect(seen).toEqual({ seen: ["note.created One.md"], greeting: "kia ora" });

    const js = await s.req("GET", "/plugins/hello/client.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect((await s.req("GET", "/plugins/hello/..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
    expect((await s.req("GET", "/plugins/hello/server.ts")).status).toBe(404); // not a client file type
    expect((await s.app.request("/plugins/hello/client.js")).status).toBe(401);

    const mcp = await s.app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${s.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hello_shout", arguments: {} } }),
    });
    expect(((await mcp.json()) as any).result.content[0].text).toBe("HELLO");
  });

  test("a broken plugin is skipped; disabled ones don't load", async () => {
    const s = await setup({
      disabled: ["off"],
      plugins: (dir) => {
        writePlugin(dir, "broken", { "plugin.json": "{ nope" });
        writePlugin(dir, "bad-id", { "plugin.json": JSON.stringify({ id: "Bad Id!" }) });
        writePlugin(dir, "throws", { "plugin.json": JSON.stringify({ id: "throws", server: "server.ts" }), "server.ts": "export default () => { throw new Error('boom') }" });
        writePlugin(dir, "off", { "plugin.json": JSON.stringify({ id: "off", name: "Off" }) });
        writePlugin(dir, "fine", { "plugin.json": JSON.stringify({ id: "fine", name: "Fine" }) });
      },
    });
    expect(s.host.list().map((p) => p.id)).toEqual(["fine"]);
  });

  test("the vault reports every kind of change", async () => {
    const s = await setup();
    const events: VaultEvent[] = [];
    s.vault.events.on("event", (e: VaultEvent) => events.push(e));
    const a = await s.vault.create("Work", "Plan", "# Plan\n- [ ] ship");
    await s.vault.write(a.path, "# Plan\n- [ ] ship\n- [ ] celebrate", a.hash);
    await s.vault.move("Work", "Archive");
    await s.req("POST", "/api/todos/toggle", { path: "Archive/Plan.md", line: 1, raw: "- [ ] ship", done: true });
    writeFileSync(join(s.vaultDir, "Outside.md"), "made in Obsidian");
    await s.vault.scan();
    const later = new Date(Date.now() + 5000);
    writeFileSync(join(s.vaultDir, "Outside.md"), "edited in Obsidian");
    utimesSync(join(s.vaultDir, "Outside.md"), later, later);
    await s.vault.scan();
    await s.vault.trash("Archive/Plan.md");
    expect(events.map((e) => `${e.type} ${e.path}${"from" in e ? ` <- ${e.from}` : ""} (${e.source})`)).toEqual([
      "note.created Work/Plan.md (sink)",
      "note.updated Work/Plan.md (sink)",
      "note.moved Archive/Plan.md <- Work/Plan.md (sink)",
      "note.updated Archive/Plan.md (sink)",
      "todo.done Archive/Plan.md (sink)",
      "note.created Outside.md (external)",
      "note.updated Outside.md (external)",
      "note.deleted Archive/Plan.md (sink)",
    ]);
    expect(events.find((e) => e.type === "todo.done")).toMatchObject({ text: "ship" });
  });
});

describe("built-in plugins", () => {
  test("daily notes: today's note from the template, Today route, assistant tool", async () => {
    const s = await setup({ builtins: [daily] });
    await s.vault.write("Templates/Daily.md", "# {{date}}\n\nStarted at {{time}}\n\n## Todo\n", null);
    const today = localIso(new Date(), "UTC").slice(0, 10);
    const { path } = (await (await s.req("POST", "/api/plugins/daily/today")).json()) as any;
    expect(path).toBe(`Daily/${today}.md`);
    expect(readFileSync(join(s.vaultDir, path), "utf8")).toMatch(new RegExp(`^# ${today}\\n\\nStarted at \\d\\d:\\d\\d\\n\\n## Todo\\n$`));
    // Asking again doesn't overwrite it.
    await s.vault.write(path, (await s.vault.read(path)).content + "kept\n", (await s.vault.read(path)).hash);
    expect(((await (await s.req("POST", "/api/plugins/daily/today")).json()) as any).path).toBe(path);
    expect(readFileSync(join(s.vaultDir, path), "utf8")).toEndWith("kept\n");

    const tool = s.host.tools.find((t) => t.name === "daily_append")!;
    expect(await tool.handler({ text: "- [ ] call mum" })).toEqual({ appended_to: path });
    expect(readFileSync(join(s.vaultDir, path), "utf8")).toEndWith("kept\n- [ ] call mum\n");
  });

  test("webhooks: off without URLs; signed, filtered, typing settles before note.updated, retries", async () => {
    expect((await setup({ builtins: [webhooksPlugin()] })).host.list()).toEqual([]);

    const calls: { url: string; headers: Headers; body: string }[] = [];
    let failFirst = true;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: new Headers(init.headers), body: String(init.body) });
      if (url.includes("flaky") && failFirst) {
        failFirst = false;
        return new Response("down", { status: 503 });
      }
      return new Response("ok");
    }) as unknown as typeof fetch;
    const s = await setup({
      builtins: [webhooksPlugin(fakeFetch, [5])],
      env: {
        SINK_PLUGIN_WEBHOOKS_URLS: "https://hooks.test/a, https://flaky.test/b",
        SINK_PLUGIN_WEBHOOKS_SECRET: "shh",
        SINK_PLUGIN_WEBHOOKS_EVENTS: "note.created,note.updated",
        SINK_PLUGIN_WEBHOOKS_QUIET_MS: "40",
      },
    });
    const n = await s.vault.create("", "Draft", "a");
    let hash = n.hash;
    for (const text of ["ab", "abc", "abcd"]) hash = (await s.vault.write(n.path, text, hash)).hash;
    await s.vault.trash(n.path); // filtered out
    await new Promise((r) => setTimeout(r, 120));

    const toA = calls.filter((c) => c.url.includes("hooks.test"));
    expect(toA.map((c) => JSON.parse(c.body).event)).toEqual(["note.created"]);
    // The burst of edits was cancelled by the delete, so no stale "updated" follows it.
    const body = toA[0]!.body;
    expect(JSON.parse(body)).toMatchObject({ event: "note.created", path: "Draft.md", title: "Draft", source: "sink" });
    expect(toA[0]!.headers.get("x-sink-signature")).toBe("sha256=" + new Bun.CryptoHasher("sha256", "shh").update(body).digest("hex"));
    expect(calls.filter((c) => c.url.includes("flaky"))).toHaveLength(2);

    calls.length = 0;
    const m = await s.vault.create("", "Second", "x");
    hash = m.hash;
    for (const text of ["xy", "xyz"]) hash = (await s.vault.write(m.path, text, hash)).hash;
    await new Promise((r) => setTimeout(r, 120));
    expect(calls.filter((c) => c.url.includes("hooks.test")).map((c) => JSON.parse(c.body).event)).toEqual(["note.created", "note.updated"]);

    // Edit then rename within the quiet time: the update follows the note to its new path, never the old one.
    calls.length = 0;
    hash = (await s.vault.write(m.path, "moved soon", hash)).hash;
    await s.vault.move(m.path, "Renamed.md");
    await new Promise((r) => setTimeout(r, 120));
    expect(calls.filter((c) => c.url.includes("hooks.test")).map((c) => JSON.parse(c.body).path)).toEqual(["Renamed.md"]);

    // A todo event for the same note doesn't swallow its waiting update.
    calls.length = 0;
    hash = (await s.vault.write("Renamed.md", "- [ ] milk", hash)).hash;
    s.vault.emit({ type: "todo.done", path: "Renamed.md", text: "milk", source: "sink" });
    await new Promise((r) => setTimeout(r, 120));
    expect(calls.filter((c) => c.url.includes("hooks.test")).map((c) => JSON.parse(c.body).event)).toEqual(["note.updated"]);
  });
});

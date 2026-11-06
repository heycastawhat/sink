import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthEnv } from "./auth";
import { ClipError, fetchPage } from "./clip";
import { openDb } from "./db";
import { Vault } from "./notes";
import { clipRoutes } from "./routes/clip";

const ARTICLE = `<!doctype html><html><head><title>Soup Weather | Example Blog</title>
<meta property="og:title" content="Soup Weather"><script>var tracker = "SCRIPT-NOISE";</script></head><body>
<nav><a href="/">Home</a><a href="/about">NAV-NOISE</a></nav>
<aside class="ad">BUY-NOW-NOISE</aside>
<article><h1>Soup Weather</h1>
<p>It was the <strong>coldest</strong> week of the year, so we made soup. Read the <a href="/recipes/lentil?x=(1)">lentil recipe</a> first, then
come back here for the story of how a pot, an onion and a very patient afternoon turned into dinner for six people on a rainy Tuesday.</p>
<p>Second paragraph with more words so the extractor is sure this is the article: stock, salt, a little lemon at the end, and bread from the bakery down the road.</p>
<img src="/img/pot.jpg" alt="A pot"><img src="data:image/png;base64,AAAA" alt="inline">
<h2>Ingredients</h2><ul><li>Onion</li><li>Lentils<ul><li>red</li></ul></li></ul>
<blockquote>Soup is just a hug in a bowl.</blockquote>
<pre>pot.heat()\npot.add("onion")</pre>
<table><tr><th>Item</th><th>Qty</th></tr><tr><td>Onion</td><td>2 | 3</td></tr></table>
<p>Closing thoughts about the whole affair, including the part where the bread was nearly burnt, which is a story for another post altogether.</p></article>
<footer>FOOTER-NOISE</footer></body></html>`;

let server: ReturnType<typeof Bun.serve>;
let origin: string;
let vault: Vault;
let app: Hono<AuthEnv>;

const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { "content-type": "text/html; charset=utf-8", ...init.headers } });

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/article") return html(ARTICLE);
      if (path === "/bare") return html("<html><body><div>Just a short line of text, no article.</div></body></html>");
      if (path === "/to-metadata") return Response.redirect("http://169.254.169.254/latest/meta-data/", 302);
      if (path === "/to-loopback-name") return Response.redirect(`http://localhost:${server.port}/article`, 302);
      if (path === "/to-ftp") return Response.redirect("ftp://example.com/x", 302);
      if (path === "/to-article") return Response.redirect("/article", 301);
      if (path === "/loop") return Response.redirect("/loop", 302);
      if (path === "/image") return new Response("x", { headers: { "content-type": "image/png" } });
      if (path === "/missing") return html("gone", { status: 404 });
      if (path === "/big") return html("<p>" + "a".repeat(3 * 1024 * 1024) + "</p>");
      if (path === "/big-streamed") {
        const chunk = new TextEncoder().encode("a".repeat(64 * 1024));
        let sent = 0;
        return html(new ReadableStream({ pull(c) { sent < 48 ? (c.enqueue(chunk), sent++) : c.close(); } }) as any);
      }
      return new Response("not found", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  vault = new Vault(openDb(":memory:"), mkdtempSync(join(tmpdir(), "sink-clip-")));
  app = new Hono<AuthEnv>();
  app.use("*", (c, next) => (c.set("subject", "me"), next()));
  app.route("/", clipRoutes(vault, "UTC", "127.0.0.1"));
});

afterAll(() => void server.stop(true));

const clip = (url: string, extra: object = {}, target = app) =>
  target.request("/clip", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, ...extra }) });

describe("clipping a page", () => {
  test("saves the article as markdown with source and date", async () => {
    const res = await clip(`${origin}/article`, { folder: "Reading" });
    expect(res.status).toBe(201);
    const note = (await res.json()) as { path: string; title: string };
    expect(note.path).toBe("Reading/Soup Weather.md");
    const { content } = await vault.read(note.path);
    expect(content).toMatch(new RegExp(`^---\nsource: "${origin}/article"\nclipped: \\d{4}-\\d{2}-\\d{2}\n---\n\n# Soup Weather\n\n`));
    expect(content).toContain("the **coldest** week");
    expect(content).toContain(`[lentil recipe](${origin}/recipes/lentil?x=%281%29)`);
    expect(content).toContain(`![A pot](${origin}/img/pot.jpg)`);
    expect(content).not.toContain("data:image");
    expect(content).toContain("## Ingredients");
    expect(content).toMatch(/- Onion\n- Lentils\n {2}- red/);
    expect(content).toContain("> Soup is just a hug in a bowl.");
    expect(content).toContain('```\npot.heat()\npot.add("onion")\n```');
    expect(content).toContain("| Item | Qty |\n| --- | --- |\n| Onion | 2 \\| 3 |");
    expect(content.match(/^# /gm)).toHaveLength(1);
    for (const noise of ["SCRIPT-NOISE", "NAV-NOISE", "BUY-NOW-NOISE", "FOOTER-NOISE"]) expect(content).not.toContain(noise);
    // It's an ordinary note: indexed with its title.
    expect((await vault.read(note.path)).title).toBe("Soup Weather");
  });

  test("a second clip of the same page doesn't overwrite the first", async () => {
    const a = (await (await clip(`${origin}/article`)).json()) as any;
    const b = (await (await clip(`${origin}/article`)).json()) as any;
    expect(a.path).not.toBe(b.path);
  });

  test("follows redirects and records where the page ended up", async () => {
    const note = (await (await clip(`${origin}/to-article`)).json()) as any;
    expect((await vault.read(note.path)).content).toContain(`source: "${origin}/article"`);
  });

  test("falls back to the page text when there's no article", async () => {
    const note = (await (await clip(`${origin}/bare`)).json()) as any;
    expect((await vault.read(note.path)).content).toContain("Just a short line of text");
  });
});

describe("clip safety", () => {
  const refused = (url: string) => expect(fetchPage(url)).rejects.toMatchObject({ status: 400 });

  test("refuses private, loopback, link-local and metadata addresses", async () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://127.1/",
      "http://2130706433/",
      "http://10.0.0.5/",
      "http://172.16.0.1/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/",
      "http://0.0.0.0/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://localhost/",
    ]) {
      await refused(url);
    }
  });

  test("refuses anything but http and https", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/x", "javascript:alert(1)", "data:text/html,hi"]) await refused(url);
    await expect(fetchPage("not a url")).rejects.toMatchObject({ status: 400 });
  });

  test("checks every redirect hop", async () => {
    for (const path of ["/to-metadata", "/to-loopback-name", "/to-ftp"]) {
      const res = await clip(`${origin}${path}`);
      expect(res.status).toBe(400);
    }
    await expect(fetchPage(`${origin}/loop`, "127.0.0.1")).rejects.toMatchObject({ status: 502, message: "too many redirects" });
  });

  test("the exemption is for the one host only", async () => {
    await expect(fetchPage(`http://localhost:${server.port}/article`, "127.0.0.1")).rejects.toMatchObject({ status: 400 });
  });

  test("only web pages, within the size cap", async () => {
    expect((await clip(`${origin}/image`)).status).toBe(415);
    expect((await clip(`${origin}/missing`)).status).toBe(502);
    expect((await clip(`${origin}/big`)).status).toBe(413);
    expect((await clip(`${origin}/big-streamed`)).status).toBe(413);
  });

  test("fetch failures say nothing about what's behind the address", async () => {
    const closed = await fetchPage("http://127.0.0.1:1/", "127.0.0.1").catch((e) => e);
    expect(closed).toBeInstanceOf(ClipError);
    expect(closed.message).toBe("couldn't fetch that page");
  });

  test("is rate limited per account", async () => {
    const fresh = new Hono<AuthEnv>();
    fresh.use("*", (c, next) => (c.set("subject", "me"), next()));
    fresh.route("/", clipRoutes(vault, "UTC"));
    for (let i = 0; i < 20; i++) expect((await clip("ftp://x", {}, fresh)).status).toBe(400);
    expect((await clip("ftp://x", {}, fresh)).status).toBe(429);
  });

  test("rejects a bad body", async () => {
    expect((await app.request("/clip", { method: "POST", body: "nope" })).status).toBe(400);
    expect((await clip(`${origin}/article`, { folder: "../x" })).status).toBeGreaterThanOrEqual(400);
  });
});

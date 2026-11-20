import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../auth";
import { ClipError, extractArticle, fetchPage, fragmentMarkdown } from "../clip";
import { VaultError, type Vault } from "../notes";
import { rateLimit } from "../ratelimit";
import { localIso } from "../time";

// With `html` (the browser extension sends the page as it shows it, so logins and scripts are already dealt with) the
// server fetches nothing; `url` is then only the source. `selection` turns that HTML into markdown without saving it.
const clipBody = z.object({
  url: z.string().max(2048),
  folder: z.string().max(1024).default(""),
  html: z.string().max(5 * 1024 * 1024).optional(),
  selection: z.boolean().optional(),
});

/** `allowHost` is for tests that serve a page from localhost; nothing in the app's config sets it. */
export function clipRoutes(vault: Vault, timeZone: string, allowHost?: string) {
  const app = new Hono<AuthEnv>();
  // Each clip makes the server fetch an arbitrary site, so cap them per account.
  const allowed = rateLimit(20, 60_000);

  app.post("/clip", async (c) => {
    const body = clipBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const { url, folder, html, selection } = body.data;
    if (html === undefined && !allowed(c.get("subject"))) return c.json({ error: "slow down" }, 429);
    try {
      if (html !== undefined && !/^https?:\/\//i.test(url)) throw new ClipError(400, "only http and https pages can be clipped");
      if (html !== undefined && selection) return c.json({ markdown: fragmentMarkdown(html, url) });
      if (selection) return c.json({ error: "a selection needs its html" }, 400);
      const page = html !== undefined ? { html, url } : await fetchPage(url, allowHost);
      const { title, markdown } = extractArticle(page.html, page.url);
      const content = [
        ["---", `source: ${JSON.stringify(page.url)}`, `clipped: ${localIso(new Date(), timeZone).slice(0, 10)}`, "---"].join("\n"),
        `# ${title}`,
        markdown,
      ]
        .filter(Boolean)
        .join("\n\n") + "\n";
      return c.json(await vault.create(folder, title, content), 201);
    } catch (err) {
      if (err instanceof ClipError || err instanceof VaultError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  return app;
}

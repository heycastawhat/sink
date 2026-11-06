import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { secureHeaders } from "hono/secure-headers";
import { Auth, authRoutes, requestOrigin, requireAuth, type AuthEnv } from "./auth";
import type { MiddlewareHandler } from "hono";
import { clipRoutes } from "./routes/clip";
import { noteRoutes } from "./routes/notes";
import { publicShareRoutes, shareRoutes } from "./routes/share";
import { eventRoutes } from "./routes/events";
import { adminRoutes } from "./routes/admin";
import { calendarRoutes } from "./routes/calendar";
import { publicPageRoutes, publishRoutes, robotsFor } from "./routes/publish";
import { todoRoutes } from "./todos";
import { pushRoutes, vapidKeys } from "./push";
import type { Vault } from "./notes";
import { pluginFileType, type PluginHost } from "./plugins";
import { handleMcp, type ApiFetch } from "./mcp";
import { oauthRoutes } from "./oauth";
import { cors } from "hono/cors";
import type { Space, Users } from "./users";
import { Passkeys } from "./passkeys";
import type { Config } from "./config";
import type { Oidc } from "./oidc";

/**
 * Defence in depth for the web app's pages: scripts only from Sink itself (WebAssembly allowed for Excalidraw's
 * font subsetting), no framing. Images in notes may come from anywhere on https, as in Obsidian.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

const appShellCsp: MiddlewareHandler = async (c, next) => {
  await next();
  if (!c.req.path.startsWith("/api/") && !c.res.headers.has("content-security-policy")) {
    c.res.headers.set("content-security-policy", CSP);
  }
};

export function createApp(deps: {
  db: Database;
  vault: Vault;
  plugins?: PluginHost;
  // Without it every sign-in shares `vault` (one account per install, as before accounts).
  users?: Users;
  auth: Auth;
  oidc: Oidc;
  config: Pick<Config, "secureCookies" | "maxUploadBytes" | "webDir" | "publicUrls"> & Partial<Pick<Config, "timeZone" | "trashDays">>;
  // Tests only: a host that web clips may reach even though it's a private address.
  clipAllowHost?: string;
}) {
  const { db, vault, plugins, users, auth, oidc, config } = deps;
  const owner: Space = { db, vault };
  const passkeys = users && new Passkeys(db);
  const spaceOf = (subject: string) => users?.for(subject) ?? owner;
  const isOwner = (subject: string) => users?.isOwner(subject) ?? true;
  const vapid = vapidKeys(db);

  // Each account's notes API, built once per vault; requests reach it with the caller's token details.
  const spaceApis = new WeakMap<Space, Hono<AuthEnv>>();
  const spaceApi = (space: Space) => {
    let api = spaceApis.get(space);
    if (api) return api;
    api = new Hono<AuthEnv>().basePath("/api");
    api.use("*", async (c, next) => {
      const vars = c.env as AuthEnv["Variables"];
      c.set("tokenId", vars.tokenId);
      c.set("scope", vars.scope);
      c.set("subject", vars.subject);
      await next();
    });
    api.route("/", noteRoutes(space.vault, config.maxUploadBytes, config.trashDays));
    api.route("/", clipRoutes(space.vault, config.timeZone ?? "UTC", deps.clipAllowHost));
    api.route("/", todoRoutes(space.db, space.vault, config.timeZone ?? "UTC"));
    api.route("/", shareRoutes(space.db, space.vault));
    api.route("/", eventRoutes(space.vault));
    api.route("/", pushRoutes(space.db, vapid.publicKey));
    api.notFound((c) => c.json({ error: "not found" }, 404));
    api.onError((err, c) => {
      console.error(err);
      return c.json({ error: "internal error" }, 500);
    });
    spaceApis.set(space, api);
    return api;
  };
  const app = new Hono<AuthEnv>();

  // Same-origin resources, except the logo: other sites show it (connector screens in Claude and others).
  const sameOrigin = secureHeaders({ crossOriginResourcePolicy: "same-origin" });
  const shareable = secureHeaders({ crossOriginResourcePolicy: "cross-origin" });
  const LOGO = /^\/(favicon\.(ico|svg)|icon-\d+\.png|icon-maskable-\d+\.png|apple-touch-icon\.png)$/;
  app.use("*", (c, next) => (LOGO.test(c.req.path) ? shareable : sameOrigin)(c, next));

  app.get("/api/health", (c) => {
    // Public (container health check), so it says nothing about the notes.
    db.query("SELECT 1").get();
    return c.json({ ok: true });
  });

  app.route("/api/auth", authRoutes(auth, oidc, { secureCookies: config.secureCookies, publicUrls: config.publicUrls, users, passkeys }));

  const api = new Hono<AuthEnv>();
  api.use("*", requireAuth(auth, config.publicUrls));
  if (users) api.route("/", publishRoutes(users));
  if (users && passkeys) api.route("/admin", adminRoutes(users, auth, oidc, passkeys, config.publicUrls));
  // Installed plugins (for clients to load) and each plugin's own routes under /api/plugins/<id>/. Plugins work on
  // the owner's vault, so only the owner gets them.
  api.get("/plugins", (c) => c.json({ plugins: isOwner(c.get("subject")) ? (plugins?.list() ?? []) : [] }));
  if (plugins) {
    api.use("/plugins/*", async (c, next) => (isOwner(c.get("subject")) ? next() : c.json({ error: "not found" }, 404)));
    api.route("/plugins", plugins.routes);
  }
  api.all("*", (c) =>
    spaceApi(spaceOf(c.get("subject"))).fetch(c.req.raw, { tokenId: c.get("tokenId"), scope: c.get("scope"), subject: c.get("subject") }),
  );
  // Obsidian's sync plugin reads the change stream with fetch (EventSource can't send the bearer header) from the
  // app's own origins. Bearer only: no credentials, so a page on one of these can't ride a session cookie.
  app.use("/api/events", cors({ origin: ["app://obsidian.md", "capacitor://localhost", "http://localhost", "https://localhost"], allowHeaders: ["authorization"] }));
  // Shared notes, readable without signing in. Before the signed-in API, which would answer 401.
  app.route("/api/public", publicShareRoutes(() => users?.all() ?? [owner]));
  if (users) app.route("/api/public/pages", publicPageRoutes(users));
  // Calendar apps can't sign in, so the feed's own token in its URL stands in; it opens nothing else.
  app.route("/api/calendar", calendarRoutes(auth, spaceOf, config.timeZone ?? "UTC"));
  app.route("/api", api);

  // A plugin's client script, styles and assets. Signed in like the API: they're the owner's code, not public.
  app.get("/plugins/:id/*", requireAuth(auth, config.publicUrls), async (c) => {
    if (!isOwner(c.get("subject"))) return c.json({ error: "not found" }, 404);
    const rel = decodeURIComponent(c.req.path.split("/").slice(3).join("/"));
    const file = plugins?.file(c.req.param("id"), rel);
    const type = file && pluginFileType(file);
    if (!file || !type) return c.json({ error: "not found" }, 404);
    // The Android editor loads these from its own origin, through the app (which adds the token).
    return new Response(Bun.file(file), { headers: { "content-type": type, "cache-control": "no-cache" } });
  });

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  // MCP for AI assistants. Connectors (claude.ai, ChatGPT, Poke) sign in through OAuth; Claude Code can also
  // take a token from the web's Connect panel as a bearer header. Called cross-origin, so CORS on these.
  const mcpCors = cors({
    origin: "*",
    allowHeaders: ["authorization", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id"],
    exposeHeaders: ["www-authenticate", "mcp-session-id"],
  });
  for (const path of ["/mcp", "/.well-known/*", "/oauth/token", "/oauth/register", "/oauth/revoke"]) app.use(path, mcpCors);
  app.route("/", oauthRoutes(db, auth, config.publicUrls));

  app.all("/mcp", async (c) => {
    // Bearer only (no session cookie), and a 401 that points clients at the OAuth metadata.
    const header = c.req.header("authorization") ?? "";
    const found = header.startsWith("Bearer ") ? auth.check(header.slice(7)) : null;
    if (!found) {
      const origin = config.publicUrls.includes(requestOrigin(c)) ? requestOrigin(c) : config.publicUrls[0];
      return c.json({ error: "unauthorized" }, 401, {
        "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      });
    }
    const api: ApiFetch = (path, init) =>
      Promise.resolve(app.request(path, { ...init, headers: { ...(init?.headers as Record<string, string>), authorization: header } }));
    const origin = config.publicUrls.includes(requestOrigin(c)) ? requestOrigin(c) : config.publicUrls[0]!;
    const tools = isOwner(found.subject) ? (plugins?.tools ?? []) : [];
    return handleMcp(c.req.raw, api, config.timeZone ?? "UTC", tools, origin);
  });

  if (config.webDir) {
    app.use("/*", appShellCsp);
    // Pages always check for a new version (else a browser keeps running the old app after a deploy); the
    // hashed files they load never change, so those can be kept for good.
    app.use("/*", async (c, next) => {
      await next();
      if (c.req.path.startsWith("/api/") || c.res.headers.has("cache-control")) return;
      const type = c.res.headers.get("content-type") ?? "";
      if (c.req.path.startsWith("/assets/")) c.header("cache-control", "public, max-age=31536000, immutable");
      else if (type.includes("text/html") || c.req.path.endsWith(".webmanifest") || c.req.path === "/sw.js") c.header("cache-control", "no-cache");
    });
    // A shared note's page; it loads the note from /api/public/share/<id>. Not for search engines, and it doesn't
    // tell the sites its links go to where the reader came from.
    app.get("/s/:id", async (c, next) => {
      await next();
      c.header("x-robots-tag", "noindex, nofollow");
      c.header("referrer-policy", "no-referrer");
    });
    app.get("/s/:id", serveStatic({ root: config.webDir, path: "share.html" }));
    // Public pages: /public (the owner's), /public/<handle> and /public/<handle>/<note path>.
    app.on("GET", ["/public", "/public/*"], async (c, next) => {
      await next();
      const robots = users ? await robotsFor(users, c.req.path) : "noindex";
      if (robots) c.header("x-robots-tag", robots);
    });
    app.get("/public", serveStatic({ root: config.webDir, path: "public.html" }));
    app.get("/public/*", serveStatic({ root: config.webDir, path: "public.html" }));
    app.use("/*", serveStatic({ root: config.webDir }));
    // An asset from an older deploy: a 404, not index.html, which would be cached for good under the asset's name.
    app.get("/assets/*", (c) => c.notFound());
    // SPA fallback.
    // `path` is joined to `root`; on its own it's read relative to the working directory, not webDir.
    app.get("*", serveStatic({ root: config.webDir, path: "index.html" }));
  }

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}

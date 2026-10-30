import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { secureHeaders } from "hono/secure-headers";
import { Auth, authRoutes, requestOrigin, requireAuth, type AuthEnv } from "./auth";
import type { MiddlewareHandler } from "hono";
import { noteRoutes } from "./routes/notes";
import { publicShareRoutes, shareRoutes } from "./routes/share";
import { eventRoutes } from "./routes/events";
import { todoRoutes } from "./todos";
import type { Vault } from "./notes";
import { pluginFileType, type PluginHost } from "./plugins";
import { handleMcp, type ApiFetch } from "./mcp";
import { oauthRoutes } from "./oauth";
import { cors } from "hono/cors";
import type { Config } from "./config";
import type { Oidc } from "./oidc";

/**
 * Defence in depth for the web app's pages: scripts only from Sink itself (WebAssembly allowed for Excalidraw's
 * font subsetting), no framing. Images in notes may come from anywhere on https, as in Obsidian.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
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
  auth: Auth;
  oidc: Oidc;
  config: Pick<Config, "secureCookies" | "maxUploadBytes" | "webDir" | "publicUrls"> & Partial<Pick<Config, "timeZone" | "trashDays">>;
}) {
  const { db, vault, plugins, auth, oidc, config } = deps;
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

  app.route("/api/auth", authRoutes(auth, oidc, { secureCookies: config.secureCookies, publicUrls: config.publicUrls }));

  const api = new Hono<AuthEnv>();
  api.use("*", requireAuth(auth, config.publicUrls));
  api.route("/", noteRoutes(vault, config.maxUploadBytes, config.trashDays));
  api.route("/", todoRoutes(db, vault, config.timeZone ?? "UTC"));
  api.route("/", shareRoutes(db, vault));
  api.route("/", eventRoutes(vault));
  // Installed plugins (for clients to load) and each plugin's own routes under /api/plugins/<id>/.
  api.get("/plugins", (c) => c.json({ plugins: plugins?.list() ?? [] }));
  if (plugins) api.route("/plugins", plugins.routes);
  // Shared notes, readable without signing in. Before the signed-in API, which would answer 401.
  app.route("/api/public", publicShareRoutes(db, vault));
  app.route("/api", api);

  // A plugin's client script, styles and assets. Signed in like the API: they're the owner's code, not public.
  app.get("/plugins/:id/*", requireAuth(auth, config.publicUrls), async (c) => {
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
    if (!header.startsWith("Bearer ") || !auth.check(header.slice(7))) {
      const origin = config.publicUrls.includes(requestOrigin(c)) ? requestOrigin(c) : config.publicUrls[0];
      return c.json({ error: "unauthorized" }, 401, {
        "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      });
    }
    const api: ApiFetch = (path, init) =>
      Promise.resolve(app.request(path, { ...init, headers: { ...(init?.headers as Record<string, string>), authorization: header } }));
    const origin = config.publicUrls.includes(requestOrigin(c)) ? requestOrigin(c) : config.publicUrls[0]!;
    return handleMcp(c.req.raw, api, config.timeZone ?? "UTC", plugins?.tools ?? [], origin);
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
      else if (type.includes("text/html") || c.req.path.endsWith(".webmanifest")) c.header("cache-control", "no-cache");
    });
    // A shared note's page; it loads the note from /api/public/share/<id>. Not for search engines, and it doesn't
    // tell the sites its links go to where the reader came from.
    app.get("/s/:id", async (c, next) => {
      await next();
      c.header("x-robots-tag", "noindex, nofollow");
      c.header("referrer-policy", "no-referrer");
    });
    app.get("/s/:id", serveStatic({ root: config.webDir, path: "share.html" }));
    app.use("/*", serveStatic({ root: config.webDir }));
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

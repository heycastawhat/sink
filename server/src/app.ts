import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { secureHeaders } from "hono/secure-headers";
import { Auth, authRoutes, requestOrigin, requireAuth, type AuthEnv } from "./auth";
import { captureRoutes } from "./routes/captures";
import { collectionRoutes } from "./routes/collections";
import { handleMcp, type ApiFetch } from "./mcp";
import { oauthRoutes } from "./oauth";
import { cors } from "hono/cors";
import type { MediaStore } from "./media";
import type { Provider } from "./ai/provider";
import type { Config } from "./config";
import type { Oidc } from "./oidc";
import type { VectorIndex } from "./semantic";

export function createApp(deps: {
  db: Database;
  media: MediaStore;
  auth: Auth;
  oidc: Oidc;
  index?: VectorIndex;
  provider: Provider;
  config: Pick<Config, "secureCookies" | "maxUploadBytes" | "webDir" | "publicUrls"> & Partial<Pick<Config, "timeZone">>;
}) {
  const { db, media, auth, oidc, index, provider, config } = deps;
  const app = new Hono<AuthEnv>();

  app.use("*", secureHeaders({ crossOriginResourcePolicy: "same-origin" }));

  app.get("/api/health", (c) => {
    const pending = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM jobs").get()!.n;
    return c.json({ ok: true, ai: provider.enabled, semantic: index?.size ?? null, pending_jobs: pending });
  });

  app.route("/api/auth", authRoutes(auth, oidc, { secureCookies: config.secureCookies, publicUrls: config.publicUrls }));

  const api = new Hono<AuthEnv>();
  api.use("*", requireAuth(auth));
  api.route("/", captureRoutes(db, media, config.maxUploadBytes, index));
  api.route("/", collectionRoutes(db));
  app.route("/api", api);

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
    if (!header.startsWith("Bearer ") || !auth.verify(header.slice(7))) {
      const origin = config.publicUrls.includes(requestOrigin(c)) ? requestOrigin(c) : config.publicUrls[0];
      return c.json({ error: "unauthorized" }, 401, {
        "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      });
    }
    const api: ApiFetch = (path, init) =>
      Promise.resolve(app.request(path, { ...init, headers: { ...(init?.headers as Record<string, string>), authorization: header } }));
    return handleMcp(c.req.raw, api, config.timeZone ?? "Pacific/Auckland");
  });

  if (config.webDir) {
    app.use("/*", serveStatic({ root: config.webDir }));
    // SPA fallback.
    app.get("*", serveStatic({ path: `${config.webDir}/index.html` }));
  }

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}

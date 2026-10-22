import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { secureHeaders } from "hono/secure-headers";
import { Auth, authRoutes, requireAuth, type AuthEnv } from "./auth";
import { captureRoutes } from "./routes/captures";
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
  config: Pick<Config, "secureCookies" | "maxUploadBytes" | "webDir" | "publicUrls">;
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
  app.route("/api", api);

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

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

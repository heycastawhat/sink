import { config } from "./config";
import { openDb } from "./db";
import { Auth } from "./auth";
import { Oidc } from "./oidc";
import { MediaStore } from "./media";
import { OpenAICompatibleProvider } from "./ai/provider";
import { Worker } from "./worker";
import { LocalEmbedder, VectorIndex } from "./semantic";
import { join } from "node:path";
import { createApp } from "./app";

const db = openDb(config.dbPath);
const media = new MediaStore(config.mediaDir);
for (const key of ["issuer", "clientId", "clientSecret"] as const) {
  if (!config.oidc[key]) throw new Error(`Set SINK_OIDC_${key.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase()}`);
}
if (!config.publicUrls.length) throw new Error("Set SINK_PUBLIC_URLS (comma-separated origins Sink is reached on)");
const auth = new Auth(db);
const oidc = new Oidc(config.oidc);
const provider = new OpenAICompatibleProvider(config.ai);
const index = new VectorIndex(db, new LocalEmbedder(join(config.dataDir, "models")));
const worker = new Worker(db, media, provider, config.worker, config.ai.maxImagePx, index, config.timeZone);

const app = createApp({ db, media, auth, oidc, index, provider, config });
worker.start();
// Load the embedding model now (downloads once into data/models) so the first search isn't slow.
index.embedder.embed(["warm up"], "query").catch((err) => console.warn(`[semantic] model load failed: ${err.message}`));

const server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
  maxRequestBodySize: config.maxUploadBytes + 1024 * 1024,
});

console.log(
  `[sink] listening on :${server.port}, data in ${config.dataDir}, ` +
    `ai ${provider.enabled ? config.ai.models.join(" -> ") : "disabled"}`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    worker.stop();
    server.stop();
    db.close();
    process.exit(0);
  });
}

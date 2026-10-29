import { config } from "./config";
import { openDb } from "./db";
import { Auth } from "./auth";
import { Oidc } from "./oidc";
import { createApp } from "./app";
import { Backups } from "./backup";
import { Vault } from "./notes";
import { EmailIngest } from "./email";
import { PluginHost } from "./plugins";
import { builtinPlugins } from "./builtin";

const db = openDb(config.dbPath);
const vault = new Vault(db, config.notesDir, config.timeZone);
for (const key of ["issuer", "clientId"] as const) {
  if (!config.oidc[key]) throw new Error(`Set SINK_OIDC_${key.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase()}`);
}
if (!config.oidc.allowedUsers.length && !config.oidc.allowedGroups.length && !config.oidc.allowAnyone) {
  throw new Error(
    "Nobody could sign in: set SINK_OIDC_ALLOWED_USERS (your username, sub or verified email) or SINK_OIDC_ALLOWED_GROUPS. " +
      "SINK_OIDC_ALLOW_ANY_USER=true lets every account at the provider in.",
  );
}
if (!config.publicUrls.length) throw new Error("Set SINK_PUBLIC_URLS (comma-separated origins Sink is reached on)");
const auth = new Auth(db);
const oidc = new Oidc(config.oidc);

const plugins = new PluginHost(vault, { timeZone: config.timeZone, dir: config.pluginsDir, disabled: config.pluginsDisabled });
await plugins.load(builtinPlugins());
const app = createApp({ db, vault, plugins, auth, oidc, config });
vault.start(config.notesScanSeconds * 1000);
let email: EmailIngest | null = null;
if (config.imap.host) {
  email = new EmailIngest(
    config.imap,
    {
      vault,
      allowedFrom: config.imap.allowedFrom,
      authservId: config.imap.authservId,
      timeZone: config.timeZone,
      maxUploadBytes: config.maxUploadBytes,
    },
    db,
  );
  email.start();
}
const backups = new Backups(db, config.backupDir, config.backupKeep);
backups.start();
const purgeTrash = () => vault.purgeTrash(config.trashDays).catch((err) => console.warn(`[notes] trash purge failed: ${err.message}`));
void purgeTrash();
const trashTimer = setInterval(purgeTrash, 60 * 60 * 1000);

const server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
  maxRequestBodySize: config.maxUploadBytes + 1024 * 1024,
});

console.log(
  `[sink] listening on :${server.port}, data in ${config.dataDir}, notes in ${config.notesDir}, ` +
    `email ${config.imap.host ? config.imap.user : "off"}`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    vault.stop();
    plugins.stop();
    void email?.stop();
    backups.stop();
    clearInterval(trashTimer);
    server.stop();
    db.close();
    process.exit(0);
  });
}

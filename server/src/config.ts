import { join, resolve } from "node:path";

function env(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

const dataDir = resolve(env("SINK_DATA_DIR", "./data")!);

export const config = {
  port: Number(env("SINK_PORT", "8787")),
  dataDir,
  // The markdown vault. Can be a NAS share; never put the database there (SQLite over SMB corrupts).
  notesDir: resolve(env("SINK_NOTES_DIR", join(dataDir, "notes"))!),
  // Plugin folders (each with a plugin.json), and built-in plugins to turn off (comma-separated ids).
  pluginsDir: resolve(env("SINK_PLUGINS_DIR", "./plugins")!),
  pluginsDisabled: list(env("SINK_PLUGINS_DISABLED")),
  // CIFS has no inotify, so edits made outside Sink (Obsidian, Finder) are found by rescanning.
  notesScanSeconds: Number(env("SINK_NOTES_SCAN_SECONDS", "30")),
  dbPath: join(dataDir, "sink.db"),
  webDir: env("SINK_WEB_DIR") ? resolve(env("SINK_WEB_DIR")!) : undefined,

  // Every origin people reach Sink on (public tunnel URL first, then LAN). OIDC redirects only go back to these.
  publicUrls: list(env("SINK_PUBLIC_URLS")).map((u) => u.replace(/\/$/, "")),
  // Cookies are always Secure over https; this forces it for plain-http origins too (breaks LAN http login).
  secureCookies: env("SINK_SECURE_COOKIES", "false") === "true",

  oidc: {
    // The provider's issuer URL, e.g. https://auth.example.com/application/o/sink/ (authentik) or https://id.example.com (Pocket ID)
    issuer: env("SINK_OIDC_ISSUER") ?? "",
    clientId: env("SINK_OIDC_CLIENT_ID") ?? "",
    clientSecret: env("SINK_OIDC_CLIENT_SECRET") ?? "",
    allowedUsers: list(env("SINK_OIDC_ALLOWED_USERS")),
    allowedGroups: list(env("SINK_OIDC_ALLOWED_GROUPS")),
    // Let every account the provider will sign in through. Only for providers that already restrict the app.
    allowAnyone: env("SINK_OIDC_ALLOW_ANY_USER", "false") === "true",
    // Shown on the sign-in button: "Sign in with <name>".
    name: env("SINK_OIDC_NAME", "")!,
  },

  // Where the user lives: todo reminders and note dates use this zone.
  timeZone: env("SINK_TIMEZONE", process.env.TZ || "UTC")!,

  // Daily database snapshots in data/backups; how many to keep (0 turns them off).
  backupDir: join(dataDir, "backups"),
  backupKeep: Number(env("SINK_BACKUP_KEEP", "7")),

  // Notes Sink moves to .trash/ are deleted for good after this many days (0 keeps them forever).
  trashDays: Number(env("SINK_TRASH_DAYS", "30")),

  maxUploadBytes: Number(env("SINK_MAX_UPLOAD_MB", "25")) * 1024 * 1024,

  // Email in: a mailbox that forwarded mail goes to. Off while host is empty.
  imap: {
    host: env("SINK_IMAP_HOST") ?? "",
    port: Number(env("SINK_IMAP_PORT", "993")),
    secure: env("SINK_IMAP_SECURE", "true") !== "false",
    user: env("SINK_IMAP_USER") ?? "",
    password: env("SINK_IMAP_PASSWORD") ?? "",
    mailbox: env("SINK_IMAP_MAILBOX", "INBOX")!,
    processedFolder: env("SINK_IMAP_PROCESSED_FOLDER", "Sink/Processed")!,
    rejectedFolder: env("SINK_IMAP_REJECTED_FOLDER", "Sink/Rejected")!,
    // Addresses or @domains whose mail is accepted; empty accepts nothing.
    allowedFrom: list(env("SINK_IMAP_ALLOWED_FROM")).map((a) => a.toLowerCase()),
    // Only trust Authentication-Results added by this server (the first word of the header, e.g. mx.google.com).
    authservId: env("SINK_IMAP_AUTHSERV_ID", "")!,
  },
};

export type Config = typeof config;

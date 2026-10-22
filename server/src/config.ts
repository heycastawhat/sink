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
  mediaDir: join(dataDir, "media"),
  dbPath: join(dataDir, "sink.db"),
  webDir: env("SINK_WEB_DIR") ? resolve(env("SINK_WEB_DIR")!) : undefined,

  // Every origin people reach Sink on (public tunnel URL first, then LAN). OIDC redirects only go back to these.
  publicUrls: list(env("SINK_PUBLIC_URLS")).map((u) => u.replace(/\/$/, "")),
  // Cookies are always Secure over https; this forces it for plain-http origins too (breaks LAN http login).
  secureCookies: env("SINK_SECURE_COOKIES", "false") === "true",

  oidc: {
    // e.g. https://auth.notahomelab.xyz/application/o/sink/
    issuer: env("SINK_OIDC_ISSUER") ?? "",
    clientId: env("SINK_OIDC_CLIENT_ID") ?? "",
    clientSecret: env("SINK_OIDC_CLIENT_SECRET") ?? "",
    allowedUsers: list(env("SINK_OIDC_ALLOWED_USERS")),
    allowedGroups: list(env("SINK_OIDC_ALLOWED_GROUPS")),
  },

  // Where the user lives: AI resolves "Friday 9am" and writes dates in this zone.
  timeZone: env("SINK_TIMEZONE", "Pacific/Auckland")!,

  // Daily database snapshots in data/backups; how many to keep (0 turns them off).
  backupDir: join(dataDir, "backups"),
  backupKeep: Number(env("SINK_BACKUP_KEEP", "7")),

  // How often each watched product page is re-checked.
  priceCheckHours: Number(env("SINK_PRICE_CHECK_HOURS", "12")),

  maxUploadBytes: Number(env("SINK_MAX_UPLOAD_MB", "25")) * 1024 * 1024,

  ai: {
    // Any OpenAI-compatible endpoint: OpenRouter by default, Ollama via http://ollama:11434/v1.
    baseUrl: env("SINK_AI_BASE_URL", "https://openrouter.ai/api/v1")!.replace(/\/$/, ""),
    apiKey: env("SINK_AI_API_KEY"),
    // Comma-separated fallback chain, tried in order.
    models: list(env("SINK_AI_MODELS")),
    maxImagePx: Number(env("SINK_AI_MAX_IMAGE_PX", "1024")),
    timeoutMs: Number(env("SINK_AI_TIMEOUT_MS", "90000")),
  },

  worker: {
    pollMs: Number(env("SINK_WORKER_POLL_MS", "2000")),
    maxAttempts: Number(env("SINK_WORKER_MAX_ATTEMPTS", "5")),
  },
};

export type Config = typeof config;

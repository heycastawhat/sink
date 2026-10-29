import { Hono } from "hono";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { z } from "zod";
import type { AuthEnv } from "./auth";
import type { Vault, VaultEvent } from "./notes";

/**
 * Plugins extend Sink without forking it. A plugin is a folder with a `plugin.json`:
 *
 *   { "id": "hello", "name": "Hello", "version": "1.0.0", "description": "…",
 *     "server": "server.ts", "client": "client.js", "styles": "styles.css" }
 *
 * `server` (optional) is a module whose default export is `setup(sink: PluginContext)`, run once at start.
 * `client` and `styles` (optional) load in the web app and the Android editor; see web/src/plugin-api.js.
 * Sink's own extras (diagrams, math, daily notes, webhooks) are built the same way, in src/plugins/.
 *
 * Plugins are code the owner chose to install, like Obsidian's: they run with Sink's own permissions.
 */

export type PluginManifest = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  server?: string;
  client?: string;
  styles?: string;
};

export type McpToolDef = {
  title?: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  readOnly?: boolean;
};

/** Text back to the assistant; throw an Error to report a failure it can act on. */
export type McpToolHandler = (args: any) => Promise<string | object>;

export type PluginContext = {
  id: string;
  /** SINK_PLUGIN_<ID>_<KEY> from the environment, e.g. sink.env("URLS") for SINK_PLUGIN_WEBHOOKS_URLS. */
  env(key: string, fallback?: string): string | undefined;
  log(...args: unknown[]): void;
  timeZone: string;
  /** The notes vault: read, write (with the hash you read), create, list, search, move, trash. */
  vault: Pick<Vault, "read" | "write" | "create" | "list" | "move" | "trash" | "saveAttachment">;
  /** Called for every change: note.created/updated/deleted/moved, todo.done/undone. */
  on(handler: (event: VaultEvent) => void | Promise<void>): void;
  /** Routes under /api/plugins/<id>/, signed in like the rest of the API. */
  routes: Hono<AuthEnv>;
  /** A tool AI assistants get over MCP, named "<id>_<name>" unless the name already starts with the id. */
  mcpTool(name: string, def: McpToolDef, handler: McpToolHandler): void;
  /** Runs fn every `ms` (and not twice at once); stopped on shutdown. */
  every(ms: number, fn: () => void | Promise<void>): void;
};

/** A plugin that ships inside Sink. `client` marks one with a part in the web bundle (web/src/plugins/<id>.js). */
export type BuiltinPlugin = PluginManifest & {
  setup?: (sink: PluginContext) => void | Promise<void>;
  bundledClient?: boolean;
  /** Off unless this returns true (e.g. webhooks needs URLs). Default: on. */
  enabledByDefault?: (env: (key: string) => string | undefined) => boolean;
};

type Loaded = PluginManifest & { dir?: string; builtin: boolean; bundledClient: boolean };

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export class PluginHost {
  readonly plugins: Loaded[] = [];
  readonly tools: { name: string; def: McpToolDef; handler: McpToolHandler }[] = [];
  readonly routes = new Hono<AuthEnv>();
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(
    private vault: Vault,
    private opts: { timeZone: string; dir?: string; disabled?: string[]; env?: Record<string, string | undefined> },
  ) {}

  private envOf(id: string) {
    const prefix = `SINK_PLUGIN_${id.toUpperCase().replace(/-/g, "_")}_`;
    const env = this.opts.env ?? process.env;
    return (key: string, fallback?: string) => {
      const v = env[prefix + key.toUpperCase()];
      return v === undefined || v === "" ? fallback : v;
    };
  }

  /** Built-ins first, then folders in the plugins directory. A plugin that fails to load is skipped, not fatal. */
  async load(builtins: BuiltinPlugin[]) {
    const disabled = new Set(this.opts.disabled ?? []);
    for (const b of builtins) {
      const env = this.envOf(b.id);
      if (disabled.has(b.id) || (b.enabledByDefault && !b.enabledByDefault((k) => env(k)))) continue;
      await this.start({ ...b, builtin: true, bundledClient: !!b.bundledClient }, b.setup);
    }
    const dir = this.opts.dir;
    if (!dir || !existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const pluginDir = join(dir, name);
      try {
        if (name.startsWith(".") || !statSync(pluginDir).isDirectory()) continue;
        const manifest = JSON.parse(readFileSync(join(pluginDir, "plugin.json"), "utf8")) as PluginManifest;
        if (!ID.test(manifest.id ?? "")) throw new Error(`plugin.json needs an id of lowercase letters, digits and dashes`);
        if (disabled.has(manifest.id)) continue;
        if (this.plugins.some((p) => p.id === manifest.id)) throw new Error(`another plugin already uses the id "${manifest.id}"`);
        let setup: BuiltinPlugin["setup"];
        if (manifest.server) {
          const mod = await import(this.fileIn(pluginDir, manifest.server)!);
          setup = mod.default ?? mod.setup;
          if (typeof setup !== "function") throw new Error(`${manifest.server} must export a setup(sink) function`);
        }
        await this.start({ ...manifest, name: manifest.name ?? manifest.id, dir: pluginDir, builtin: false, bundledClient: false }, setup);
      } catch (err) {
        console.warn(`[plugins] skipped ${name}: ${(err as Error).message}`);
      }
    }
  }

  private async start(plugin: Loaded, setup?: BuiltinPlugin["setup"]) {
    const routes = new Hono<AuthEnv>();
    const log = (...args: unknown[]) => console.log(`[plugin:${plugin.id}]`, ...args);
    const ctx: PluginContext = {
      id: plugin.id,
      env: this.envOf(plugin.id),
      log,
      timeZone: this.opts.timeZone,
      vault: this.vault,
      on: (handler) => {
        this.vault.events.on("event", (event: VaultEvent) => {
          // One plugin's mistake mustn't break saving a note.
          Promise.resolve()
            .then(() => handler(event))
            .catch((err) => log(`error handling ${event.type}:`, (err as Error).message));
        });
      },
      routes,
      mcpTool: (name, def, handler) => {
        const full = name.startsWith(plugin.id.replace(/-/g, "_")) ? name : `${plugin.id.replace(/-/g, "_")}_${name}`;
        this.tools.push({ name: full, def, handler });
      },
      every: (ms, fn) => {
        let running = false;
        this.timers.push(
          setInterval(async () => {
            if (running) return;
            running = true;
            try {
              await fn();
            } catch (err) {
              log("scheduled job failed:", (err as Error).message);
            } finally {
              running = false;
            }
          }, Math.max(1000, ms)),
        );
      },
    };
    if (setup) await setup(ctx);
    this.routes.route(`/${plugin.id}`, routes);
    this.plugins.push(plugin);
    console.log(`[plugins] loaded ${plugin.id}${plugin.builtin ? " (built in)" : ""}`);
  }

  /** What clients load: bundled parts by id, others from /plugins/<id>/<file>. */
  list() {
    return this.plugins.map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version ?? null,
      description: p.description ?? null,
      builtin: p.builtin,
      bundled_client: p.bundledClient,
      client: !p.builtin && p.client ? `/plugins/${p.id}/${p.client}` : null,
      styles: !p.builtin && p.styles ? `/plugins/${p.id}/${p.styles}` : null,
    }));
  }

  /** A file inside an installed plugin's folder (for its client script, styles and assets), never outside it. */
  file(id: string, rel: string): string | null {
    const plugin = this.plugins.find((p) => p.id === id && p.dir);
    return plugin ? this.fileIn(plugin.dir!, rel) : null;
  }

  private fileIn(dir: string, rel: string): string | null {
    const abs = resolve(dir, rel);
    return abs.startsWith(resolve(dir) + sep) && existsSync(abs) ? abs : null;
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
  }
}

export const PLUGIN_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

export const pluginFileType = (path: string) => PLUGIN_TYPES[extname(path).toLowerCase()];

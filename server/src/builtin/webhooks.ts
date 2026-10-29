import type { BuiltinPlugin } from "../plugins";
import type { VaultEvent } from "../notes";

/**
 * Webhooks: POSTs a JSON event to each URL when notes or todos change, for n8n, Home Assistant, Zapier or a script.
 *   SINK_PLUGIN_WEBHOOKS_URLS    comma-separated; the plugin is off without it
 *   SINK_PLUGIN_WEBHOOKS_SECRET  signs each body: X-Sink-Signature: sha256=<HMAC-SHA256 hex of the body>
 *   SINK_PLUGIN_WEBHOOKS_EVENTS  comma-separated filter, e.g. todo.done,note.created (default: all)
 * Autosave updates a note every few seconds while someone types, so note.updated is sent once the note has been
 * quiet for SINK_PLUGIN_WEBHOOKS_QUIET_MS (default 5000).
 */
export function webhooksPlugin(fetchImpl: typeof fetch = fetch, retryDelays = [1000, 5000, 25_000]): BuiltinPlugin {
  return {
    id: "webhooks",
    name: "Webhooks",
    description: "Sends note and todo events to URLs you choose.",
    enabledByDefault: (env) => !!env("URLS"),
    setup(sink) {
      const urls = (sink.env("URLS") ?? "").split(",").map((u) => u.trim()).filter(Boolean);
      const secret = sink.env("SECRET");
      const only = new Set((sink.env("EVENTS") ?? "").split(",").map((e) => e.trim()).filter(Boolean));
      const quietMs = Number(sink.env("QUIET_MS", "5000"));
      const waiting = new Map<string, ReturnType<typeof setTimeout>>();

      const send = async (event: VaultEvent) => {
        const title = event.type.startsWith("note.") && event.type !== "note.deleted"
          ? sink.vault.list().notes.find((n) => n.path === event.path)?.title
          : undefined;
        const body = JSON.stringify({ ...event, event: event.type, type: undefined, title, at: new Date().toISOString() });
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "user-agent": "Sink-Webhooks/1",
          "x-sink-event": event.type,
        };
        if (secret) headers["x-sink-signature"] = "sha256=" + new Bun.CryptoHasher("sha256", secret).update(body).digest("hex");
        await Promise.all(
          urls.map(async (url) => {
            for (let attempt = 0; ; attempt++) {
              try {
                const res = await fetchImpl(url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
                if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return;
                throw new Error(`HTTP ${res.status}`);
              } catch (err) {
                if (attempt >= retryDelays.length) return sink.log(`gave up on ${url}: ${(err as Error).message}`);
                await new Promise((r) => setTimeout(r, retryDelays[attempt]));
              }
            }
          }),
        );
      };

      sink.on((event) => {
        // Any newer event for a note supersedes its waiting update, even one this hook doesn't send:
        // a delete must not be followed by a stale "updated".
        const pending = waiting.get(event.path);
        if (pending) {
          clearTimeout(pending);
          waiting.delete(event.path);
        }
        if (only.size && !only.has(event.type)) return;
        if (event.type !== "note.updated") return send(event);
        waiting.set(
          event.path,
          setTimeout(() => {
            waiting.delete(event.path);
            void send(event);
          }, quietMs),
        );
      });
    },
  };
}

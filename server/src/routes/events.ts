import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AuthEnv } from "../auth";
import type { Vault, VaultEvent } from "../notes";

/**
 * Live changes for open apps (Server-Sent Events): each note or todo event as it happens, from Sink or from a scan
 * that found an outside edit. Clients refresh what they show; nothing in an event is needed to stay correct, so a
 * dropped connection only means waiting for the next poll. A comment every 25s keeps proxies (Cloudflare's tunnel
 * closes idle ones after 100s) from cutting it.
 */
export function eventRoutes(vault: Vault, keepAliveMs = 25_000) {
  const app = new Hono<AuthEnv>();
  app.get("/events", (c) => {
    c.header("cache-control", "no-store");
    c.header("x-accel-buffering", "no");
    return streamSSE(c, async (stream) => {
      const send = (e: VaultEvent) => {
        const { source: _source, ...data } = e as VaultEvent & { text?: string };
        void stream.writeSSE({ event: "change", data: JSON.stringify(data) });
      };
      vault.events.on("event", send);
      let open = true;
      stream.onAbort(() => {
        open = false;
      });
      await stream.writeSSE({ event: "ready", data: "{}" });
      try {
        while (open) {
          await stream.sleep(keepAliveMs);
          if (open) await stream.write(": ping\n\n");
        }
      } finally {
        vault.events.off("event", send);
      }
    });
  });
  return app;
}

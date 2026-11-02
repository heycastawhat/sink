/**
 * Hears about changes on the server. The stream is Server-Sent Events read with fetch, because EventSource can't send
 * the bearer header. Where that can't work (no streaming, a network that blocks it) it falls back to polling, and
 * keeps trying the stream. An event only means "something changed": the sync works out what.
 */
type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export class Live {
  private stopped = true;
  private ctrl: AbortController | null = null;
  private fails = 0;
  private poller: ReturnType<typeof setInterval> | null = null;
  mode: "live" | "polling" | "off" = "off";

  constructor(
    private o: {
      url: string;
      token: () => string;
      onChange: () => void;
      onMode?: (mode: "live" | "polling") => void;
      fetch?: Fetch;
      pollMs?: number;
      retryMs?: number;
    },
  ) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loop();
  }

  stop() {
    this.stopped = true;
    this.ctrl?.abort();
    this.setMode("off");
  }

  /** Drops the connection so it's made again now (the app came back to the foreground). */
  reconnect() {
    this.ctrl?.abort();
  }

  private setMode(mode: Live["mode"]) {
    if (mode === "polling" && !this.poller) this.poller = setInterval(this.o.onChange, this.o.pollMs ?? 60_000);
    if (mode !== "polling" && this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode !== "off") this.o.onMode?.(mode);
  }

  private async loop() {
    while (!this.stopped) {
      const opened = await this.stream().then(
        () => true,
        () => false,
      );
      this.fails = opened ? 0 : this.fails + 1;
      if (this.stopped) break;
      // A dropped connection that had been fine retries quickly; one that never opens falls back to polling.
      if (this.fails >= 2) this.setMode("polling");
      const retry = this.o.retryMs ?? 2000;
      await new Promise((r) => setTimeout(r, Math.min(retry * 2 ** this.fails, retry * 150)));
    }
  }

  private async stream() {
    const ctrl = (this.ctrl = new AbortController());
    // The server pings every 25s; silence for much longer means the connection died without saying so.
    let watchdog: ReturnType<typeof setTimeout>;
    const bump = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => ctrl.abort(), 75_000);
    };
    bump();
    try {
      const res = await (this.o.fetch ?? fetch)(this.o.url, { headers: { authorization: `Bearer ${this.o.token()}` }, signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`events: HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let ready = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bump();
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop()!;
          for (const block of blocks) {
            const event = /^event: *(.*)$/m.exec(block)?.[1];
            if (event === "ready") {
              ready = true;
              this.setMode("live");
              this.o.onChange();
            } else if (event === "change") this.o.onChange();
          }
        }
      } catch (err) {
        // A connection that was working and then dropped is a retry, not a failure to connect.
        if (!ready) throw err;
      }
      if (!ready) throw new Error("events: closed before ready");
    } finally {
      clearTimeout(watchdog!);
    }
  }
}

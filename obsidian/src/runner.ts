export type RunOpts = { scan?: boolean; confirmDeletes?: boolean };

/**
 * One sync at a time, debounced. Asking while one runs queues another after it; asks that arrive together run once
 * with their options combined. A steady stream of asks (typing) still runs every `maxWaitMs`.
 */
export class Runner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: RunOpts | null = null;
  private firstAsk = 0;
  private loop: Promise<void> | null = null;

  constructor(
    private run: (opts: RunOpts) => Promise<void>,
    private maxWaitMs = 30_000,
  ) {}

  private add(opts: RunOpts) {
    this.pending = { scan: this.pending?.scan || opts.scan, confirmDeletes: this.pending?.confirmDeletes || opts.confirmDeletes };
  }

  /** Sync soon: after `delayMs` of quiet. */
  request(delayMs = 0, opts: RunOpts = {}) {
    this.add(opts);
    if (this.timer) clearTimeout(this.timer);
    else this.firstAsk = Date.now();
    const wait = Math.max(0, Math.min(delayMs, this.firstAsk + this.maxWaitMs - Date.now()));
    this.timer = setTimeout(() => void this.go(), wait);
  }

  /** Sync now, and resolve once it (and anything queued behind it) has finished. */
  now(opts: RunOpts = {}): Promise<void> {
    this.add(opts);
    return this.go();
  }

  cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  private go(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return (this.loop ??= (async () => {
      try {
        while (this.pending) {
          const opts = this.pending;
          this.pending = null;
          await this.run(opts).catch((err) => console.error("[sink]", err));
        }
      } finally {
        this.loop = null;
      }
    })());
  }
}

import type { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const DAY = 24 * 60 * 60 * 1000;
const NAME = /^sink-(\d{4}-\d{2}-\d{2})\.db$/;

/**
 * Daily consistent snapshot of the database into `dir` (VACUUM INTO is safe under WAL with writers).
 * Media files are append-only, so copying /data with these snapshots is a full backup.
 */
export class Backups {
  private timer: Timer | undefined;

  constructor(
    private db: Database,
    private dir: string,
    private keep: number,
  ) {}

  start() {
    if (this.keep <= 0) return;
    this.run();
    // Hourly check is cheap; at most one snapshot per calendar day.
    this.timer = setInterval(() => this.run(), DAY / 24);
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Returns the snapshot path if one was made. */
  run(today = new Date()): string | null {
    try {
      mkdirSync(this.dir, { recursive: true });
      const path = join(this.dir, `sink-${today.toISOString().slice(0, 10)}.db`);
      let made: string | null = null;
      if (!existsSync(path)) {
        this.db.query("VACUUM INTO ?").run(path);
        made = path;
      }
      this.prune();
      return made;
    } catch (err) {
      console.warn(`[backup] failed: ${(err as Error).message}`);
      return null;
    }
  }

  private prune() {
    const snapshots = readdirSync(this.dir)
      .filter((f) => NAME.test(f))
      .sort()
      .reverse();
    for (const old of snapshots.slice(this.keep)) rmSync(join(this.dir, old));
  }
}

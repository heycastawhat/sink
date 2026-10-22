import type { Database } from "bun:sqlite";
import type { Config } from "./config";
import type { MediaStore } from "./media";
import { ProviderError, type Provider } from "./ai/provider";
import { runOcr } from "./ocr";
import { newId, now } from "./db";
import type { VectorIndex } from "./semantic";
import { utcOffset } from "./ai/extract";

type Job = { id: number; capture_id: string; kind: string; attempts: number };
type CaptureRow = {
  id: string;
  created_at: number;
  image_path: string;
  note_text: string | null;
  ocr_text: string | null;
  app_package: string | null;
  source_url: string | null;
};

/** When a suggested action wants attention: reminders/todos by their due time, events by their start. */
export function dueAt(action: { type: string; payload: Record<string, unknown> }, timeZone: string): number | null {
  const raw = action.type === "calendar" ? action.payload.start : action.payload.due;
  if (typeof raw !== "string") return null;
  // Date-only values ("2026-10-30") mean 9am that day for the user.
  let value = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T09:00:00` : raw;
  // No zone given: it's the user's wall-clock time, not the server's (UTC in the container).
  if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value)) {
    const guess = Date.parse(`${value}Z`);
    if (Number.isNaN(guess)) return null;
    value += utcOffset(new Date(guess), timeZone);
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export type JobKind = "process" | "embed";

export function enqueue(db: Database, captureId: string, kind: JobKind = "process") {
  db.query("DELETE FROM jobs WHERE capture_id = ? AND kind = ?").run(captureId, kind);
  db.query("INSERT INTO jobs (capture_id, kind, run_after) VALUES (?, ?, ?)").run(captureId, kind, now());
  if (kind === "process") db.query("UPDATE captures SET status = 'pending', error = NULL WHERE id = ?").run(captureId);
}

export class Worker {
  private timer: Timer | undefined;
  private busy = false;

  constructor(
    private db: Database,
    private media: MediaStore,
    private provider: Provider,
    private cfg: Config["worker"],
    private aiMaxPx: number,
    private index?: VectorIndex,
    private timeZone = "Pacific/Auckland",
  ) {}

  start() {
    // Anything left mid-flight by a crash goes back to pending.
    this.db.query("UPDATE captures SET status = 'pending' WHERE status = 'processing'").run();
    // Index anything without a vector (first run, or the embedding model changed).
    if (this.index) for (const id of this.index.missing()) enqueue(this.db, id, "embed");
    this.timer = setInterval(() => void this.tick(), this.cfg.pollMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Processes due jobs one at a time until none are left. Returns how many ran. */
  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let ran = 0;
    try {
      let job: Job | null;
      while ((job = this.nextJob())) {
        await this.run(job);
        ran++;
      }
    } finally {
      this.busy = false;
    }
    return ran;
  }

  private nextJob(): Job | null {
    return this.db
      .query<Job, [number]>(
        "SELECT id, capture_id, kind, attempts FROM jobs WHERE run_after <= ? ORDER BY run_after LIMIT 1",
      )
      .get(now());
  }

  private async run(job: Job) {
    const capture = this.db
      .query<CaptureRow, [string]>(
        "SELECT id, created_at, image_path, note_text, ocr_text, app_package, source_url FROM captures WHERE id = ?",
      )
      .get(job.capture_id);
    if (!capture) {
      this.db.query("DELETE FROM jobs WHERE id = ?").run(job.id);
      return;
    }

    if (job.kind === "embed") {
      try {
        await this.index?.update(capture.id);
        this.db.query("DELETE FROM jobs WHERE id = ?").run(job.id);
      } catch (err) {
        const attempts = job.attempts + 1;
        const message = (err as Error).message.slice(0, 500);
        if (attempts < this.cfg.maxAttempts) {
          this.db
            .query("UPDATE jobs SET attempts = ?, run_after = ?, last_error = ? WHERE id = ?")
            .run(attempts, now() + 30_000 * 4 ** job.attempts, message, job.id);
        } else this.db.query("DELETE FROM jobs WHERE id = ?").run(job.id);
        console.warn(`[worker] embed ${capture.id} attempt ${attempts}: ${message}`);
      }
      return;
    }

    this.db.query("UPDATE captures SET status = 'processing' WHERE id = ?").run(capture.id);
    try {
      await this.process(capture);
      this.db.query("DELETE FROM jobs WHERE id = ?").run(job.id);
      if (this.index) enqueue(this.db, capture.id, "embed");
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      const attempts = job.attempts + 1;
      const retryable = !(err instanceof ProviderError) || err.retryable;
      if (retryable && attempts < this.cfg.maxAttempts) {
        // 30s, 2m, 8m, 32m...
        const delay = 30_000 * 4 ** job.attempts;
        this.db
          .query("UPDATE jobs SET attempts = ?, run_after = ?, last_error = ? WHERE id = ?")
          .run(attempts, now() + delay, message, job.id);
        this.db.query("UPDATE captures SET status = 'pending', error = ? WHERE id = ?").run(message, capture.id);
      } else {
        this.db.query("DELETE FROM jobs WHERE id = ?").run(job.id);
        // Capture stays searchable through OCR + note even when AI gives up.
        this.db.query("UPDATE captures SET status = 'failed', error = ? WHERE id = ?").run(message, capture.id);
        if (this.index) enqueue(this.db, capture.id, "embed");
      }
      console.warn(`[worker] capture ${capture.id} attempt ${attempts}: ${message}`);
    }
  }

  private async process(capture: CaptureRow) {
    let ocrText = capture.ocr_text;
    if (!ocrText) {
      ocrText = await runOcr(this.media.path(capture.image_path));
      if (ocrText) this.db.query("UPDATE captures SET ocr_text = ? WHERE id = ?").run(ocrText, capture.id);
    }

    if (!this.provider.enabled) {
      this.db.query("UPDATE captures SET status = 'done', updated_at = ? WHERE id = ?").run(now(), capture.id);
      return;
    }

    const { extraction, model } = await this.provider.extract({
      imageDataUrl: await this.media.forModel(capture.image_path, this.aiMaxPx),
      note: capture.note_text,
      ocrText,
      appPackage: capture.app_package,
      sourceUrl: capture.source_url,
      capturedAt: new Date(capture.created_at),
      timeZone: this.timeZone,
    });

    this.db.transaction(() => {
      this.db
        .query(
          `UPDATE captures SET status = 'done', error = NULL, kind = ?, title = ?, summary = ?,
             tags = ?, entities = ?, model = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          extraction.kind,
          extraction.title,
          extraction.summary,
          JSON.stringify(extraction.tags),
          JSON.stringify(extraction.entities),
          model,
          now(),
          capture.id,
        );
      // Reprocessing replaces suggestions but keeps anything the user already acted on.
      this.db.query("DELETE FROM actions WHERE capture_id = ? AND state = 'suggested'").run(capture.id);
      const insert = this.db.query(
        "INSERT INTO actions (id, capture_id, type, label, payload, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const action of extraction.actions) {
        insert.run(newId(), capture.id, action.type, action.label, JSON.stringify(action.payload), dueAt(action, this.timeZone), now());
      }
    })();
  }
}

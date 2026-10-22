import type { Database } from "bun:sqlite";
import { now } from "./db";

export interface Embedder {
  readonly model: string;
  /** Hits need a lift (score minus the capture's background score) >= minLift, within `band` of the best. */
  readonly minLift: number;
  readonly band: number;
  embed(texts: string[], kind: "query" | "doc"): Promise<Float32Array[]>;
}

/**
 * nomic-embed-text-v1.5 via transformers.js (ONNX, q8, CPU). Picked over bge-small/gte/e5 after a
 * bake-off on screenshot-style OCR text: best top-1 and clearest margin. Free, local, downloads once.
 * Raw scores sit in a narrow band, so search ranks by lift over each capture's background score
 * (see VectorIndex). On the bake-off set real matches lift 0.055+, unrelated queries stay under 0.03.
 */
export class LocalEmbedder implements Embedder {
  readonly model = "nomic-ai/nomic-embed-text-v1.5";
  readonly minLift = 0.045;
  readonly band = 0.05;
  private pipe: Promise<(texts: string[], opts: object) => Promise<{ tolist(): number[][] }>> | undefined;

  constructor(private cacheDir: string) {}

  private load() {
    this.pipe ??= (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.cacheDir = this.cacheDir;
      const p = await pipeline("feature-extraction", this.model, { dtype: "q8" });
      return p as unknown as (texts: string[], opts: object) => Promise<{ tolist(): number[][] }>;
    })().catch((err) => {
      this.pipe = undefined;
      throw err;
    });
    return this.pipe;
  }

  async embed(texts: string[], kind: "query" | "doc") {
    const pipe = await this.load();
    const prefix = kind === "query" ? "search_query: " : "search_document: ";
    const out = await pipe(texts.map((t) => prefix + t), { pooling: "mean", normalize: true });
    return out.tolist().map((v) => Float32Array.from(v));
  }
}

type DocRow = {
  id: string;
  title: string | null;
  summary: string | null;
  note_text: string | null;
  tags: string;
  ocr_text: string | null;
};

/** What a capture "means" for search: the user's words and the AI's first, then the raw OCR. */
export function docText(row: DocRow): string {
  const tags = (JSON.parse(row.tags) as string[]).join(" ");
  return [row.title, row.summary, row.note_text, tags, row.ocr_text?.slice(0, 1500)]
    .filter((s) => s && s.trim())
    .join("\n")
    .trim();
}

const hash = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

// Meaning-only hits are a hint, not a list: keyword matches carry the long tail.
const MAX_SEMANTIC_HITS = 10;

// Generic queries a capture is compared against to learn its "background" similarity. Screenshots full
// of generic UI text score medium against everything (hubness); ranking by lift over this cancels it out.
const BACKGROUND_QUERIES = [
  "what time is it", "photo", "important thing", "note to self", "screenshot from my phone",
  "something I saved", "information", "the thing from last week", "app settings", "a message",
  "website", "list", "details", "reminder", "help", "news", "page", "update", "price", "date",
];

/**
 * Vectors live in SQLite (capture_vectors) and are mirrored in memory for search.
 * A brute-force dot product over a few thousand 384-dim vectors is a few milliseconds.
 */
export class VectorIndex {
  private vectors = new Map<string, Float32Array>();
  private baselines = new Map<string, number>();
  private background: Promise<Float32Array[]> | undefined;

  constructor(
    private db: Database,
    readonly embedder: Embedder,
  ) {
    const rows = db
      .query<{ capture_id: string; vec: Uint8Array }, [string]>(
        "SELECT capture_id, vec FROM capture_vectors WHERE model = ?",
      )
      .all(embedder.model);
    for (const r of rows) this.vectors.set(r.capture_id, new Float32Array(r.vec.slice().buffer));
  }

  get size() {
    return this.vectors.size;
  }

  /** Captures with no vector for the current model (new installs, model changes). */
  missing(): string[] {
    return this.db
      .query<{ id: string }, [string]>(
        `SELECT c.id FROM captures c LEFT JOIN capture_vectors v ON v.capture_id = c.id AND v.model = ?
         WHERE v.capture_id IS NULL`,
      )
      .all(this.embedder.model)
      .map((r) => r.id);
  }

  private backgroundVectors() {
    this.background ??= this.embedder.embed(BACKGROUND_QUERIES, "query").catch((err) => {
      this.background = undefined;
      throw err;
    });
    return this.background;
  }

  private async baseline(id: string, vec: Float32Array): Promise<number> {
    let b = this.baselines.get(id);
    if (b === undefined) {
      const bg = await this.backgroundVectors();
      b = bg.reduce((sum, q) => sum + dot(vec, q), 0) / bg.length;
      this.baselines.set(id, b);
    }
    return b;
  }

  /** Re-embeds a capture if its text changed since last time. */
  async update(captureId: string): Promise<void> {
    const row = this.db
      .query<DocRow, [string]>("SELECT id, title, summary, note_text, tags, ocr_text FROM captures WHERE id = ?")
      .get(captureId);
    if (!row) return this.remove(captureId);
    const text = docText(row);
    if (!text) return this.remove(captureId);

    const textHash = hash(text);
    const existing = this.db
      .query<{ text_hash: string }, [string, string]>(
        "SELECT text_hash FROM capture_vectors WHERE capture_id = ? AND model = ?",
      )
      .get(captureId, this.embedder.model);
    if (existing?.text_hash === textHash && this.vectors.has(captureId)) return;

    const [vec] = await this.embedder.embed([text], "doc");
    this.db
      .query(
        `INSERT INTO capture_vectors (capture_id, model, text_hash, vec, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(capture_id) DO UPDATE SET model = excluded.model, text_hash = excluded.text_hash,
           vec = excluded.vec, updated_at = excluded.updated_at`,
      )
      .run(captureId, this.embedder.model, textHash, new Uint8Array(vec!.buffer), now());
    this.vectors.set(captureId, vec!);
    this.baselines.delete(captureId);
  }

  remove(captureId: string) {
    this.vectors.delete(captureId);
    this.baselines.delete(captureId);
    this.db.query("DELETE FROM capture_vectors WHERE capture_id = ?").run(captureId);
  }

  async search(query: string, limit = 200): Promise<{ id: string; score: number }[]> {
    if (!this.vectors.size) return [];
    const [q] = await this.embedder.embed([query], "query");
    const hits: { id: string; score: number }[] = [];
    for (const [id, v] of this.vectors) {
      const lift = dot(v, q!) - (await this.baseline(id, v));
      if (lift >= this.embedder.minLift) hits.push({ id, score: lift });
    }
    hits.sort((a, b) => b.score - a.score);
    const top = hits[0]?.score ?? 0;
    return hits.filter((h) => h.score >= top - this.embedder.band).slice(0, Math.min(limit, MAX_SEMANTIC_HITS));
  }
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Reciprocal rank fusion: merges ranked id lists without needing comparable scores. */
export function fuse(...lists: string[][]): string[] {
  const K = 60;
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (K + rank + 1)));
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

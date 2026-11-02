export const isNote = (path: string) => path.toLowerCase().endsWith(".md");

/**
 * Whether the server would take this path (cleanPath in server/src/notes.ts, plus the folders its scan skips). Anything
 * else stays local: syncing it would only fail, or worse, look deleted when the server doesn't list it.
 */
export function syncable(path: string): boolean {
  const parts = path.split("/");
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    parts.every((p) => p.length > 0 && p.length <= 255 && !p.startsWith(".") && p !== "node_modules" && !/[\\:*?"<>|\u0000-\u001f]/.test(p) && p.trim() === p)
  );
}

const CONFLICT = / \(conflict \d{4}-\d{2}-\d{2}(?: \d+)?\)(?:\.excalidraw)?(?:\.[^./]+)?$/;
export const isConflictCopy = (path: string) => CONFLICT.test(path);

/** Where the local version goes when both sides changed: `Note (conflict 2026-11-02).md`, numbered if taken. */
export function conflictPath(path: string, date: string, taken: (path: string) => boolean): string {
  const dir = path.slice(0, path.lastIndexOf("/") + 1);
  const name = path.slice(dir.length);
  const ext = /\.excalidraw\.md$/i.test(name) ? ".excalidraw.md" : (/\.[^.]+$/.exec(name)?.[0] ?? "");
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = `${dir}${stem} (conflict ${date}${n > 1 ? ` ${n}` : ""})${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

/** The folder setting as a path prefix: no slashes at the ends, "" for the whole vault. */
export const cleanFolder = (raw: string) => raw.trim().replace(/^\/+|\/+$/g, "");

export const normalizeServer = (raw: string) => raw.trim().replace(/\/+$/, "");

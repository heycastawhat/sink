/** Sink's HTTP API as the plugin uses it. `Http` is `requestUrl` in Obsidian (no CORS on mobile) and a test server in tests. */
export type Http = (req: {
  url: string;
  method: string;
  headers: Record<string, string>;
  contentType?: string;
  body?: string | ArrayBuffer;
}) => Promise<{ status: number; text: string; arrayBuffer: ArrayBuffer }>;

export type FileMeta = { path: string; mtime: number; size: number; hash: string };
export type NoteFile = FileMeta & { content: string };
export type Version = { id: number; at: number; size: number; preview: string };

/** No answer: offline, the server is down, or its storage is. Nothing is lost; the next sync retries. */
export class OfflineError extends Error {}
/** The token isn't valid any more (signed out from Sink's settings). */
export class AuthError extends Error {}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
/** A save found the file changed since it was last seen; `current` is what's there now (a note with its text). */
export class Conflict extends ApiError {
  constructor(
    message: string,
    public current?: FileMeta | NoteFile,
  ) {
    super(409, message);
  }
}

export class SinkApi {
  constructor(
    private base: string,
    private token: string,
    private http: Http,
  ) {}

  private async call(method: string, path: string, init: { query?: Record<string, string>; json?: unknown; body?: ArrayBuffer } = {}) {
    const query = init.query ? "?" + new URLSearchParams(init.query) : "";
    let res;
    try {
      res = await this.http({
        url: `${this.base}/api${path}${query}`,
        method,
        headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
        contentType: init.json !== undefined ? "application/json" : init.body ? "application/octet-stream" : undefined,
        body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      });
    } catch {
      throw new OfflineError("can't reach the server");
    }
    if (res.status === 401 && this.token) throw new AuthError("signed out");
    if (res.status >= 502) throw new OfflineError(`server unavailable (${res.status})`);
    if (res.status >= 400) {
      const body = (() => {
        try {
          return JSON.parse(res.text) as { error?: string; current?: FileMeta | NoteFile };
        } catch {
          return {};
        }
      })();
      const message = body.error ?? `HTTP ${res.status}`;
      throw res.status === 409 ? new Conflict(message, body.current) : new ApiError(res.status, message);
    }
    return res;
  }

  private async json<T>(method: string, path: string, init?: Parameters<SinkApi["call"]>[2]): Promise<T> {
    return JSON.parse((await this.call(method, path, init)).text) as T;
  }

  /** Makes the server look for edits made outside Sink before the next list. */
  async scan() {
    await this.call("POST", "/notes/scan");
  }

  async notes(): Promise<FileMeta[]> {
    return (await this.json<{ notes: FileMeta[] }>("GET", "/notes", { query: { brief: "true" } })).notes;
  }

  async files(): Promise<FileMeta[]> {
    return (await this.json<{ items: FileMeta[] }>("GET", "/notes/attachments")).items;
  }

  getNote(path: string) {
    return this.json<NoteFile>("GET", "/notes/file", { query: { path } });
  }

  putNote(path: string, content: string, base: string | null, keepVersion = false) {
    return this.json<FileMeta>("PUT", "/notes/file", { query: { path }, json: { content, base_hash: base, ...(keepVersion && { keep_version: true }) } });
  }

  async getFile(path: string): Promise<ArrayBuffer> {
    return (await this.call("GET", "/notes/attachment", { query: { path } })).arrayBuffer;
  }

  putFile(path: string, bytes: ArrayBuffer, base: string | null) {
    return this.json<FileMeta>("PUT", "/notes/attachment", { query: { path, ...(base && { base_hash: base }) }, body: bytes });
  }

  async move(from: string, to: string) {
    await this.call("POST", "/notes/move", { json: { from, to } });
  }

  /** To Sink's trash. Already gone is fine. */
  async trash(path: string) {
    try {
      await this.call("DELETE", "/notes/file", { query: { path } });
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
  }

  async versions(path: string): Promise<Version[]> {
    return (await this.json<{ items: Version[] }>("GET", "/notes/versions", { query: { path } })).items;
  }

  async version(path: string, id: number): Promise<{ id: number; at: number; content: string }> {
    return this.json("GET", `/notes/versions/${id}`, { query: { path } });
  }

  async share(path: string): Promise<string> {
    return (await this.json<{ id: string }>("POST", "/notes/share", { json: { path } })).id;
  }

  async logout() {
    await this.call("POST", "/auth/logout");
  }
}

/** Swaps the hand-back code from the browser (plus the PKCE verifier) for a device token. */
export async function exchangeCode(base: string, code: string, verifier: string, http: Http): Promise<string> {
  const res = await http({ url: `${base}/api/auth/oidc/exchange`, method: "POST", headers: {}, contentType: "application/json", body: JSON.stringify({ code, verifier }) });
  if (res.status !== 200) throw new ApiError(res.status, "sign-in code expired or invalid");
  return (JSON.parse(res.text) as { token: string }).token;
}

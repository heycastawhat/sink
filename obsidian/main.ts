import { debounce, Notice, Platform, Plugin, requestUrl, TFile, TFolder, type TAbstractFile } from "obsidian";
import { AuthError, exchangeCode, SinkApi, Conflict, type Http } from "./src/api";
import { emptyState, SyncEngine, trackFolderRename, trackRename, type SyncResult, type SyncState } from "./src/engine";
import { base64url, randomString, sha256Bytes } from "./src/hash";
import { Live } from "./src/live";
import { cleanFolder, isNote, normalizeServer } from "./src/paths";
import { Runner, type RunOpts } from "./src/runner";
import { SinkSettingTab } from "./src/settings";
import { confirm, HistoryModal } from "./src/ui";
import { ObsidianLocal } from "./src/vault";

type Data = {
  server: string;
  token: string;
  folder: string;
  login: { verifier: string; server: string; at: number } | null;
  state: SyncState;
};

const http: Http = async (req) => {
  const res = await requestUrl({ ...req, throw: false });
  return {
    status: res.status,
    get text() {
      return res.text;
    },
    get arrayBuffer() {
      return res.arrayBuffer;
    },
  };
};

const LOGIN_TTL_MS = 10 * 60_000;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default class SinkPlugin extends Plugin {
  data!: Data;
  private tab!: SinkSettingTab;
  private statusEl!: HTMLElement;
  private runner = new Runner((o) => this.sync(o));
  private live: Live | null = null;
  private busy: { done: number; total: number } | null = null;
  private last: SyncResult | null = null;
  private failure = "";
  private retryMs = 15_000;
  private ready = false;
  saveSoon = debounce(() => void this.saveNow(), 2000, true);

  async onload() {
    const saved = (await this.loadData()) as Partial<Data> | null;
    this.data = { server: "", token: "", folder: "", login: null, ...saved, state: { ...emptyState(), ...saved?.state } };

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("sink-status");
    this.registerDomEvent(this.statusEl, "click", () => this.statusClick());
    this.addSettingTab((this.tab = new SinkSettingTab(this.app, this)));
    this.registerObsidianProtocolHandler("sink-auth", (params) => void this.finishSignIn(params.code));

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow() });
    this.noteCommand("open-in-sink", "Open in Sink", (path) => {
      window.open(`${normalizeServer(this.data.server)}/#/n/${path.split("/").map(encodeURIComponent).join("/")}`);
    });
    this.noteCommand("copy-share-link", "Copy share link", (path) => this.copyShareLink(path));
    this.noteCommand("version-history", "Version history", (path) =>
      new HistoryModal(this.app, this.api(), path, (content) => this.restore(path, content)).open(),
    );

    this.render();
    // Before the layout is ready the vault is still being read in: every file looks new, and a missing one isn't missing.
    this.app.workspace.onLayoutReady(() => this.begin());
  }

  onunload() {
    this.live?.stop();
    this.runner.cancel();
    void this.saveNow();
  }

  private begin() {
    this.ready = true;
    const v = this.app.vault;
    this.registerEvent(v.on("create", (f) => this.touched(f)));
    this.registerEvent(v.on("modify", (f) => this.touched(f)));
    this.registerEvent(v.on("delete", (f) => this.touched(f)));
    this.registerEvent(
      v.on("rename", (f, old) => {
        const local = this.local();
        const [from, to] = [local.toRemote(old), local.toRemote(f.path)];
        if (this.data.token && from !== null && to !== null) {
          if (f instanceof TFolder) trackFolderRename(this.data.state, from, to);
          else trackRename(this.data.state, from, to);
        }
        this.touched(f);
      }),
    );
    // Events can be missed (asleep, a dropped stream); this catches up.
    this.registerInterval(window.setInterval(() => this.runner.request(0), 5 * 60_000));
    this.registerDomEvent(window, "online", () => this.runner.request(0));
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.hidden || !this.data.token) return;
      this.live?.reconnect();
      this.runner.request(500);
    });
    this.connect();
  }

  /** Start syncing and listening, if signed in. */
  private connect() {
    this.live?.stop();
    this.live = null;
    if (!this.data.token) return this.render();
    this.live = new Live({
      url: `${normalizeServer(this.data.server)}/api/events`,
      token: () => this.data.token,
      onChange: () => this.runner.request(1500),
    });
    this.live.start();
    this.runner.request(0, { scan: true });
  }

  private touched(f: TAbstractFile) {
    if (this.data.token && this.local().toRemote(f.path) !== null) this.runner.request(4000);
  }

  private local() {
    return new ObsidianLocal(this.app, this.data.folder);
  }

  api() {
    return new SinkApi(normalizeServer(this.data.server), this.data.token, http);
  }

  async saveNow() {
    await this.saveData(this.data);
  }

  // ---- sync

  private async sync(opts: RunOpts) {
    if (!this.data.token || !this.ready) return;
    this.busy = { done: 0, total: 0 };
    this.render();
    const engine = new SyncEngine(this.local(), this.api(), this.data.state, {
      save: () => this.saveSoon(),
      progress: (done, total) => {
        this.busy = { done, total };
        this.render();
      },
    });
    try {
      const r = (this.last = await engine.sync(opts));
      this.failure = "";
      if (r.offline) {
        this.runner.request(this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 300_000);
      } else this.retryMs = 15_000;
      if (r.conflicts.length) {
        new Notice(`Sink: both versions of ${plural(r.conflicts.length, "file")} were kept. Look for "(conflict …)" in the file name.`, 10_000);
      }
      if (r.blocked) new Notice("Sink: a lot of deletions are waiting for you to confirm. Run \"Sync now\" to review them.", 10_000);
    } catch (err) {
      if (err instanceof AuthError) {
        this.data.token = "";
        this.live?.stop();
        new Notice("Sink: you've been signed out. Sign in again in Settings → Sink.", 10_000);
      } else {
        console.error("[sink]", err);
        this.failure = (err as Error).message;
      }
    } finally {
      this.busy = null;
      this.render();
      await this.saveNow();
    }
  }

  async syncNow() {
    if (!this.data.token) return void new Notice("Sink: sign in first, in Settings → Sink.");
    await this.runner.now({ scan: true });
    const held = this.last?.blocked;
    if (held) {
      const text = `Sync would delete ${plural(held.local, "file")} here (to your trash) and ${plural(held.remote, "file")} on Sink (to Sink's trash). That's a lot, and usually means one side is empty by mistake. Check before you continue.`;
      if (await confirm(this.app, "Delete these files?", text, "Delete")) await this.runner.now({ confirmDeletes: true });
    }
  }

  // ---- status

  statusText(): string {
    const r = this.last;
    if (!this.data.token) return "not signed in";
    if (this.busy) return this.busy.total ? `syncing ${this.busy.done}/${this.busy.total}` : "syncing…";
    if (this.failure) return "sync failed";
    if (!r) return "waiting";
    if (r.offline) return "offline";
    if (r.blocked) return "deletions to review";
    if (r.errors.length) return plural(r.errors.length, "problem");
    if (r.conflictCopies) return plural(r.conflictCopies, "conflict");
    return "synced";
  }

  private render() {
    this.statusEl.setText(`Sink: ${this.statusText()}`);
    this.statusEl.setAttr("aria-label", "Click to sync with Sink");
  }

  private statusClick() {
    const problems = this.last?.errors.slice(0, 5).map((e) => `${e.path}: ${e.message}`) ?? [];
    if (this.failure) problems.push(this.failure);
    if (problems.length) new Notice(`Sink problems:\n${problems.join("\n")}`, 10_000);
    void this.syncNow();
  }

  // ---- sign in

  async signIn() {
    const server = normalizeServer(this.data.server);
    if (!/^https?:\/\/[^/]+/.test(server)) return void new Notice("Sink: enter the server address first, like https://sink.example.com");
    const verifier = randomString(32);
    this.data.login = { verifier, server, at: Date.now() };
    await this.saveNow();
    const challenge = base64url(await sha256Bytes(verifier));
    const device = encodeURIComponent(Platform.isMobile ? "Obsidian (mobile)" : "Obsidian (desktop)");
    window.open(`${server}/api/auth/oidc/start?client=obsidian&challenge=${challenge}&device=${device}`);
  }

  /** The browser sent us back to obsidian://sink-auth?code=…: swap it for a token. */
  private async finishSignIn(code: string | undefined) {
    const login = this.data.login;
    if (!login || !code || Date.now() - login.at > LOGIN_TTL_MS) return void new Notice("Sink: that sign-in link expired. Start again from Settings → Sink.");
    try {
      this.data.token = await exchangeCode(login.server, code, login.verifier, http);
    } catch (err) {
      return void new Notice(`Sink: sign-in failed: ${(err as Error).message}`);
    }
    // A fresh sign-in merges what's here with what's there, rather than trusting what was synced before: it may be
    // another account, and "gone from the server" would then look like a deletion.
    Object.assign(this.data, { server: login.server, login: null, state: emptyState() });
    this.last = null;
    await this.saveNow();
    this.tab.display();
    new Notice("Sink: signed in. Syncing…");
    // Before the layout is ready, begin() will do this.
    if (this.ready) this.connect();
  }

  async signOut() {
    this.live?.stop();
    this.runner.cancel();
    await this.api()
      .logout()
      .catch(() => {});
    Object.assign(this.data, { token: "", state: emptyState() });
    this.last = null;
    this.failure = "";
    await this.saveNow();
    this.render();
    new Notice("Sink: signed out. Your notes stay in this vault.");
  }

  async setFolder(raw: string) {
    const folder = cleanFolder(raw);
    if (folder === this.data.folder) return;
    // What was synced may now be outside the folder, which would look like deleting it.
    Object.assign(this.data, { folder, state: emptyState() });
    await this.saveNow();
    if (this.data.token) this.runner.request(0, { scan: true });
  }

  // ---- commands on the open note

  private noteCommand(id: string, name: string, run: (remotePath: string) => void | Promise<void>) {
    this.addCommand({
      id,
      name,
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const path = file && this.local().toRemote(file.path);
        if (!this.data.token || !path || !isNote(path)) return false;
        if (!checking) void Promise.resolve(run(path)).catch((err: Error) => new Notice(`Sink: ${err.message}`));
        return true;
      },
    });
  }

  private async copyShareLink(path: string) {
    // The note has to be on the server before it can be shared.
    await this.runner.now();
    const url = `${normalizeServer(this.data.server)}/s/${await this.api().share(path)}`;
    try {
      await navigator.clipboard.writeText(url);
      new Notice("Sink: share link copied. Anyone with it can read the note.");
    } catch {
      new Notice(`Sink: share link: ${url}`, 20_000);
    }
  }

  /** Saves an old version as the note's text, keeping the current text as a version, and brings it here. */
  private async restore(path: string, content: string) {
    await this.runner.now();
    const synced = this.data.state.files[path];
    if (!synced) throw new Error("this note hasn't reached Sink yet");
    try {
      await this.api().putNote(path, content, synced.hash, true);
    } catch (err) {
      throw err instanceof Conflict ? new Error("the note changed on Sink meanwhile; try again") : err;
    }
    await this.runner.now();
    new Notice("Sink: version restored.");
  }
}

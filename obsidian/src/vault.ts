import { TFile, type App } from "obsidian";
import type { Local, LocalFile } from "./engine";
import { syncable } from "./paths";

const same = (a: ArrayBuffer, b: ArrayBuffer) => a.byteLength === b.byteLength && new Uint8Array(a).every((x, i) => x === new Uint8Array(b)[i]);

/** The Obsidian vault as the engine sees it: paths relative to the sync folder, which is the vault root unless set. */
export class ObsidianLocal implements Local {
  constructor(
    private app: App,
    private folder: string,
  ) {}

  private toLocal(path: string) {
    return this.folder ? `${this.folder}/${path}` : path;
  }

  /** The server's path for a vault path, or null if it's outside the sync folder or isn't something the server takes. */
  toRemote(path: string): string | null {
    const rel = !this.folder ? path : path.startsWith(this.folder + "/") ? path.slice(this.folder.length + 1) : null;
    return rel !== null && !path.startsWith(this.app.vault.configDir + "/") && syncable(rel) ? rel : null;
  }

  async list(): Promise<LocalFile[]> {
    return this.app.vault.getFiles().flatMap((f) => {
      const path = this.toRemote(f.path);
      return path === null ? [] : [{ path, mtime: f.stat.mtime, size: f.stat.size }];
    });
  }

  private file(path: string): TFile {
    const f = this.app.vault.getAbstractFileByPath(this.toLocal(path));
    if (!(f instanceof TFile)) throw new Error("file is gone");
    return f;
  }

  private exists(path: string) {
    return this.app.vault.getAbstractFileByPath(this.toLocal(path)) instanceof TFile;
  }

  async stat(path: string) {
    const st = await this.app.vault.adapter.stat(this.toLocal(path));
    if (!st) throw new Error("file is gone");
    return { mtime: st.mtime, size: st.size };
  }

  readText(path: string) {
    return this.app.vault.read(this.file(path));
  }

  readBytes(path: string) {
    return this.app.vault.readBinary(this.file(path));
  }

  private async folderFor(path: string) {
    const parts = this.toLocal(path).split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir).catch(() => {});
    }
  }

  async writeText(path: string, text: string, before: string | null) {
    if (before === null) {
      if (this.exists(path)) return false;
      await this.folderFor(path);
      await this.app.vault.create(this.toLocal(path), text);
      return true;
    }
    if (!this.exists(path)) return false;
    let unchanged = true;
    // process() reads and writes in one step, so an edit landing in between can't be lost.
    await this.app.vault.process(this.file(path), (now) => {
      unchanged = now === before;
      return unchanged ? text : now;
    });
    return unchanged;
  }

  async writeBytes(path: string, bytes: ArrayBuffer, before: ArrayBuffer | null) {
    if (before === null) {
      if (this.exists(path)) return false;
      await this.folderFor(path);
      await this.app.vault.createBinary(this.toLocal(path), bytes);
      return true;
    }
    if (!this.exists(path) || !same(await this.readBytes(path), before)) return false;
    await this.app.vault.modifyBinary(this.file(path), bytes);
    return true;
  }

  trash(path: string) {
    return this.app.fileManager.trashFile(this.file(path));
  }
}

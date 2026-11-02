import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { Backups } from "./backup";
import { newId, now, openDb } from "./db";
import { Vault } from "./notes";

/** One account's notes: its vault and the database indexing it (todos, links, versions, shares, trash). */
export type Space = { db: Database; vault: Vault };

type User = { subject: string; dir: string };
export type Account = {
  subject: string;
  email: string | null;
  username: string | null;
  owner: boolean;
  created_at: number;
  seen_at: number | null;
};

/**
 * Accounts and their vaults. The owner (whoever was using Sink before it had accounts, else the first to sign in)
 * keeps the configured notes folder and main database, with email in and plugins. Everyone else gets their own folder
 * under `dir`, with its own database, so nothing one account does can reach another's notes.
 */
export class Users {
  private spaces = new Map<string, Space & { backups?: Backups }>();

  constructor(
    private db: Database,
    private owner: Space,
    private opts: { dir: string; timeZone?: string; scanMs?: number; backupKeep?: number },
  ) {
    for (const u of this.db.query<User, []>("SELECT subject, dir FROM users WHERE dir != ''").all()) this.open(u.dir);
  }

  /** The account's space, setting one up on its first visit. Tokens are only issued to allowed sign-ins. */
  for(subject: string): Space {
    const { dir } = this.ensure(subject);
    return dir ? this.open(dir) : this.owner;
  }

  /** Remembers who signed in, for Settings and for signing them out when their entry is removed. */
  seen(id: { sub: string; email?: string; username?: string }) {
    this.ensure(id.sub);
    this.db
      .query("UPDATE users SET email = ?, username = ?, seen_at = ? WHERE subject = ?")
      .run(id.email ?? null, id.username ?? null, now(), id.sub);
  }

  touch(subject: string) {
    this.db.query("UPDATE users SET seen_at = ? WHERE subject = ?").run(now(), subject);
  }

  accounts(): Account[] {
    return this.db
      .query<Omit<Account, "owner"> & { dir: string }, []>("SELECT * FROM users ORDER BY created_at")
      .all()
      .map(({ dir, ...a }) => ({ ...a, owner: dir === "" }));
  }

  /** Allowlist entries added in Settings (same forms as SINK_OIDC_ALLOWED_USERS). */
  allowed(): string[] {
    return this.db.query<{ entry: string }, []>("SELECT entry FROM allowed_users ORDER BY created_at").all().map((r) => r.entry);
  }

  allow(entry: string) {
    this.db.query("INSERT OR IGNORE INTO allowed_users (entry, created_at) VALUES (?, ?)").run(entry, now());
  }

  disallow(entry: string) {
    this.db.query("DELETE FROM allowed_users WHERE entry = ?").run(entry);
  }

  private ensure(subject: string): User {
    let user = this.db.query<User, [string]>("SELECT subject, dir FROM users WHERE subject = ?").get(subject);
    if (!user) {
      const hasOwner = !!this.db.query("SELECT 1 FROM users WHERE dir = ''").get();
      user = { subject, dir: hasOwner ? newId() : "" };
      this.db.query("INSERT INTO users (subject, dir, created_at) VALUES (?, ?, ?)").run(subject, user.dir, now());
    }
    return user;
  }

  isOwner(subject: string): boolean {
    return this.for(subject) === this.owner;
  }

  /** Every space, for share links (which don't say whose they are). */
  all(): Space[] {
    return [this.owner, ...this.spaces.values()];
  }

  async purgeTrash(days: number) {
    for (const s of this.spaces.values()) await s.vault.purgeTrash(days);
  }

  stop() {
    for (const s of this.spaces.values()) {
      s.vault.stop();
      s.backups?.stop();
      s.db.close();
    }
  }

  private open(dir: string): Space {
    let space = this.spaces.get(dir);
    if (space) return space;
    const home = join(this.opts.dir, dir);
    const db = openDb(join(home, "sink.db"));
    space = { db, vault: new Vault(db, join(home, "notes"), this.opts.timeZone) };
    if (this.opts.scanMs) space.vault.start(this.opts.scanMs);
    if (this.opts.backupKeep) {
      space.backups = new Backups(db, join(home, "backups"), this.opts.backupKeep);
      space.backups.start();
    }
    this.spaces.set(dir, space);
    return space;
  }
}

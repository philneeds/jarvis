import { spawn } from "node:child_process";
import { createGzip } from "node:zlib";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { Store } from "./store/types.js";

/**
 * Nightly backup of everything HQ knows. Postgres is dumped with pg_dump (plain SQL, gzipped); the JSON store is copied.
 * Files go to BACKUP_DIR (default /var/backups/jarvis), kept BACKUP_KEEP_DAYS (default 14), and a copy goes to Phil's
 * Google Drive ("Jarvis backups" folder) when a Drive uploader is given. Restore: gunzip -c <file> | psql "$DATABASE_URL".
 */
export interface BackupStatus { at: string; ok: boolean; file?: string; bytes?: number; drive?: "uploaded" | "skipped" | string; error?: string; kept?: number }
export interface DriveUploader { upload(name: string, data: Buffer, mime: string): Promise<string>; prune?(keepDays: number): Promise<number> }
export const BACKUP_STATUS_KEY = "backup.status";

export interface BackupOptions { dir?: string; keepDays?: number; databaseUrl?: string; dataFile?: string; drive?: DriveUploader; now?: () => Date; pgDump?: string }

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);

export async function runBackup(store: Store, opts: BackupOptions = {}): Promise<BackupStatus> {
  const now = opts.now?.() ?? new Date();
  const dir = opts.dir ?? process.env.BACKUP_DIR ?? "/var/backups/jarvis";
  const keepDays = opts.keepDays ?? Number(process.env.BACKUP_KEEP_DAYS ?? 14);
  const url = opts.databaseUrl ?? process.env.DATABASE_URL;
  const dataFile = opts.dataFile ?? process.env.JARVIS_DATA_FILE ?? "data/jarvis.json";
  const status: BackupStatus = { at: now.toISOString(), ok: false };
  try {
    await fs.mkdir(dir, { recursive: true });
    const name = url ? `jarvis-${stamp(now)}.sql.gz` : `jarvis-${stamp(now)}.json.gz`;
    const file = path.join(dir, name);
    if (url) {
      // pg_dump streams SQL; a non-zero exit or empty output is a failed backup, never a silently empty file.
      const p = spawn(opts.pgDump ?? "pg_dump", ["--no-owner", "--no-privileges", "--dbname", url], { stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      p.stderr.on("data", (d) => { err += d.toString(); });
      const exit = new Promise<number>((res) => p.on("exit", (code) => res(code ?? 1)));
      await pipeline(p.stdout, createGzip(), createWriteStream(file));
      const code = await exit;
      if (code !== 0) throw new Error(`pg_dump exited ${code}: ${err.trim().slice(0, 300) || "no output"}`);
    } else {
      const data = await fs.readFile(dataFile).catch(() => { throw new Error(`no database and no data file at ${dataFile}`); });
      await pipeline(Readable.from([data]), createGzip(), createWriteStream(file));
    }
    const { size } = await fs.stat(file);
    if (size < 64) throw new Error("backup file is empty");
    status.file = file; status.bytes = size;
    // Keep the last N days locally.
    const cutoff = now.getTime() - keepDays * 86_400_000;
    let kept = 0;
    for (const f of await fs.readdir(dir)) {
      if (!/^jarvis-\d{8}-\d{4}\.(sql|json)\.gz$/.test(f)) continue;
      const st = await fs.stat(path.join(dir, f));
      if (st.mtimeMs < cutoff) await fs.rm(path.join(dir, f), { force: true }); else kept++;
    }
    status.kept = kept;
    if (opts.drive) {
      try { await opts.drive.upload(name, await fs.readFile(file), "application/gzip"); await opts.drive.prune?.(keepDays); status.drive = "uploaded"; }
      catch (e) { status.drive = `Drive copy failed: ${(e as Error).message.slice(0, 200)}`; }
    } else status.drive = "skipped";
    status.ok = true;
  } catch (e) {
    status.error = (e as Error).message;
  }
  await store.settings.set(BACKUP_STATUS_KEY, status);
  return status;
}

export async function backupStatus(store: Store): Promise<BackupStatus | null> { return store.settings.get<BackupStatus | null>(BACKUP_STATUS_KEY, null); }

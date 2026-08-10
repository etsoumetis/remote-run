import * as vscode from 'vscode';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import type { SshManager } from './sshManager';

const DIR_NAME = 'preview-cache';

export interface RemoteStat {
  size: number;
  mtime: number;
}

/**
 * Disk cache for previewed remote files.
 *
 * Files are streamed to disk rather than buffered, so peak memory stays at one
 * chunk regardless of file size. The cache key embeds mtime+size, which means a
 * file edited on the remote produces a different key and is re-fetched — no
 * staleness check needed on the hot path.
 */
export class PreviewCache implements vscode.Disposable {
  private readonly dir: string;
  private pruning?: Promise<void>;

  constructor(
    context: vscode.ExtensionContext,
    private readonly ssh: SshManager,
  ) {
    this.dir = path.join(context.globalStorageUri.fsPath, DIR_NAME);
  }

  get directory(): string {
    return this.dir;
  }

  /**
   * Fire-and-forget housekeeping at activation — never blocks startup.
   *
   * If the cache is meant to be wiped on exit, wipe it here too: a crash or a
   * force-quit skips dispose(), and this is the only other moment we are
   * guaranteed to run. Otherwise just enforce the size budget.
   */
  startupCleanup(): void {
    const wipe = vscode.workspace.getConfiguration('remoteRun')
      .get<boolean>('preview.clearCacheOnExit', true);
    if (wipe) {
      void this.clear();
      return;
    }
    this.pruneInBackground();
  }

  /** Fire-and-forget: never block activation on disk I/O. */
  pruneInBackground(): void {
    if (this.pruning) return;
    this.pruning = this.prune().catch(() => { /* cache pruning is best-effort */ })
      .finally(() => { this.pruning = undefined; });
  }

  async stat(hostId: string, remotePath: string): Promise<RemoteStat> {
    const sftp = await this.ssh.getSftp(hostId, 'transfer');
    return new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err, s) => {
        if (err) { reject(err); return; }
        resolve({ size: s.size ?? 0, mtime: Math.floor(s.mtime ?? 0) });
      });
    });
  }

  /**
   * Returns the local path of the cached copy, downloading it first if needed.
   * Shows a cancellable progress notification for anything non-trivial.
   */
  async fetch(
    hostId: string,
    remotePath: string,
    stat: RemoteStat,
    displayName: string,
  ): Promise<string> {
    const target = this.pathFor(hostId, remotePath, stat);

    if (await exists(target)) {
      // Refresh mtime so LRU pruning treats this as recently used.
      await fsp.utimes(target, new Date(), new Date()).catch(() => {});
      return target;
    }

    await fsp.mkdir(path.dirname(target), { recursive: true });
    // Unique suffix: a preview and a "Save a copy" of the same file can be in
    // flight at once, and they must not write over each other's partial.
    const partial = `${target}.${crypto.randomBytes(4).toString('hex')}.part`;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Loading ${displayName}`,
        cancellable: true,
      },
      (progress, token) => this.download(hostId, remotePath, partial, stat.size, progress, token),
    );

    try {
      await fsp.rename(partial, target);
    } catch (err) {
      // A concurrent fetch of the same file won the race. On Windows rename
      // onto an existing file throws, and its result is byte-identical anyway.
      if (!await exists(target)) throw err;
      await fsp.rm(partial, { force: true }).catch(() => {});
    }
    this.pruneInBackground();
    return target;
  }

  private async download(
    hostId: string,
    remotePath: string,
    localPath: string,
    size: number,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const sftp = await this.ssh.getSftp(hostId, 'transfer');
    let cancelSub: vscode.Disposable | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        const read  = sftp.createReadStream(remotePath);
        const write = fs.createWriteStream(localPath);
        let done = 0;
        let lastReported = 0;

        const fail = (err: Error) => {
          read.destroy();
          write.destroy();
          reject(err);
        };

        cancelSub = token.onCancellationRequested(() => fail(new vscode.CancellationError()));

        read.on('data', (chunk: Buffer) => {
          done += chunk.length;
          // Throttle progress updates — one per ~2% avoids flooding the UI thread.
          if (size > 0 && done - lastReported > size / 50) {
            progress.report({
              increment: ((done - lastReported) / size) * 100,
              message: `${formatBytes(done)} / ${formatBytes(size)}`,
            });
            lastReported = done;
          }
        });

        read.on('error', fail);
        write.on('error', fail);
        write.on('finish', resolve);
        read.pipe(write);
      });
    } catch (err) {
      await fsp.rm(localPath, { force: true }).catch(() => {});
      throw err;
    } finally {
      cancelSub?.dispose();
    }
  }

  private pathFor(hostId: string, remotePath: string, stat: RemoteStat): string {
    const hash = crypto.createHash('sha1')
      .update(`${hostId}\0${remotePath}`)
      .digest('hex')
      .slice(0, 16);
    const ext  = path.extname(remotePath).toLowerCase();
    const base = path.basename(remotePath, ext).replace(/[^\w.-]/g, '_').slice(0, 40);
    return path.join(this.dir, `${hash}-${stat.mtime}-${stat.size}-${base}${ext}`);
  }

  /** Drops least-recently-used entries until the cache fits under the configured cap. */
  private async prune(): Promise<void> {
    const capMb = vscode.workspace.getConfiguration('remoteRun')
      .get<number>('preview.maxCacheSizeMB', 256);
    const cap = capMb * 1024 * 1024;

    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return; // cache dir does not exist yet
    }

    const entries = await Promise.all(names.map(async name => {
      const full = path.join(this.dir, name);
      try {
        const s = await fsp.stat(full);
        return { full, size: s.size, used: s.mtimeMs };
      } catch {
        return undefined;
      }
    }));

    const live = entries.filter((e): e is NonNullable<typeof e> => !!e);
    let total = live.reduce((sum, e) => sum + e.size, 0);
    if (total <= cap) return;

    live.sort((a, b) => a.used - b.used); // oldest first
    for (const entry of live) {
      if (total <= cap) break;
      await fsp.rm(entry.full, { force: true }).catch(() => {});
      total -= entry.size;
    }
  }

  async clear(): Promise<void> {
    await fsp.rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Synchronous wipe for deactivate(). VS Code gives extensions only a short
   * window to shut down, and an awaited promise there is not guaranteed to run
   * to completion — so this one place uses the sync API deliberately.
   */
  clearSync(): void {
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch { /* best effort — the next activation prunes anyway */ }
  }

  dispose(): void {
    if (vscode.workspace.getConfiguration('remoteRun').get<boolean>('preview.clearCacheOnExit', true)) {
      this.clearSync();
    }
  }
}

async function exists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true; } catch { return false; }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

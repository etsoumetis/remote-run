import * as vscode from 'vscode';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { SFTPWrapper } from 'ssh2';
import type { SshManager } from './sshManager';
import type { HostConfig } from './hostConfig';
import { formatBytes } from './previewCache';

export interface RemoteRef {
  hostId: string;
  path: string;
  isDirectory: boolean;
}

interface PlannedFile {
  from: string;
  to: string;
  size: number;
  mode?: number;
  mtime?: number;
}

/**
 * Moves files between remote hosts.
 *
 * Cross-host copies are piped straight from one SFTP session into the other, so
 * nothing is staged on the local disk and memory stays at one buffer per file
 * regardless of how large the tree is. Same-host copies skip the round trip
 * entirely and run as a single shell command.
 */
export class TransferManager {
  constructor(private readonly ssh: SshManager) {}

  async copy(source: RemoteRef, destHost: HostConfig, destDir: string): Promise<boolean> {
    const name   = path.posix.basename(source.path);
    const target = joinPosix(destDir, name);

    if (source.hostId === destHost.id && source.path === target) {
      vscode.window.showInformationMessage('Source and destination are the same.');
      return false;
    }

    const destSftp = await this.ssh.getSftp(destHost.id, 'transfer');
    if (await exists(destSftp, target)) {
      const go = await vscode.window.showWarningMessage(
        `"${name}" already exists in ${destDir}.`,
        { modal: true },
        'Overwrite',
      );
      if (go !== 'Overwrite') return false;
    }

    if (source.hostId === destHost.id) {
      return this.copyOnHost(source, destHost, target);
    }
    return this.copyAcrossHosts(source, destHost.id, target, name);
  }

  /** Same host: let the remote shell do the work — no bytes cross the network. */
  private async copyOnHost(source: RemoteRef, host: HostConfig, target: string): Promise<boolean> {
    const cmd = host.remoteOs === 'windows'
      ? `powershell -NoProfile -Command "Copy-Item -LiteralPath '${psQuote(source.path)}' -Destination '${psQuote(target)}' -Recurse -Force"`
      : `cp -a -- '${shQuote(source.path)}' '${shQuote(target)}'`;

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Copying ${path.posix.basename(source.path)}…` },
      () => this.ssh.exec(host.id, cmd),
    );

    if (result.code !== 0) {
      vscode.window.showErrorMessage(`Copy failed: ${result.stderr.trim() || `exit ${result.code}`}`);
      return false;
    }
    return true;
  }

  private async copyAcrossHosts(
    source: RemoteRef,
    destHostId: string,
    target: string,
    name: string,
  ): Promise<boolean> {
    const srcSftp  = await this.ssh.getSftp(source.hostId,  'transfer');
    const destSftp = await this.ssh.getSftp(destHostId,     'transfer');

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Transferring ${name}`,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: 'Scanning…' });
        let plan: PlannedFile[];
        if (source.isDirectory) {
          const scan = await this.planDirectory(srcSftp, source.path, target, token);
          plan = scan.files;
          // Recreate the shape of the tree first, so directories that happen to
          // be empty survive the copy instead of silently vanishing.
          for (const dir of scan.dirs) await mkdirp(destSftp, dir);
        } else {
          plan = [await this.planFile(srcSftp, source.path, target)];
        }

        const totalBytes = plan.reduce((sum, f) => sum + f.size, 0);
        let sentBytes = 0;
        let fileIndex = 0;

        for (const file of plan) {
          if (token.isCancellationRequested) throw new vscode.CancellationError();
          fileIndex++;
          const shortName = path.posix.basename(file.from);

          await mkdirp(destSftp, path.posix.dirname(file.to));
          await this.pipeFile(srcSftp, destSftp, file, token, chunk => {
            sentBytes += chunk;
            progress.report({
              increment: totalBytes > 0 ? (chunk / totalBytes) * 100 : 0,
              message: plan.length > 1
                ? `${fileIndex}/${plan.length} · ${shortName} · ${formatBytes(sentBytes)} of ${formatBytes(totalBytes)}`
                : `${formatBytes(sentBytes)} of ${formatBytes(totalBytes)}`,
            });
          });
        }
        return true;
      },
    );
  }

  /**
   * Uploads a file or folder from this machine to a remote host.
   *
   * Same streaming discipline as the host-to-host path: bytes go from a local
   * read stream straight into an SFTP write stream, so a 4 GB video costs one
   * buffer of memory rather than four gigabytes.
   */
  async uploadLocal(localPath: string, destHost: HostConfig, destDir: string): Promise<boolean> {
    const name   = path.basename(localPath);
    const target = joinPosix(destDir, name);

    const stats = await fsp.stat(localPath);
    const destSftp = await this.ssh.getSftp(destHost.id, 'transfer');

    if (await exists(destSftp, target)) {
      const go = await vscode.window.showWarningMessage(
        `"${name}" already exists in ${destDir} on ${destHost.label}.`,
        { modal: true },
        'Overwrite',
      );
      if (go !== 'Overwrite') return false;
    }

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Uploading ${name} to ${destHost.label}`,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: 'Scanning…' });
        let plan: PlannedFile[];

        if (stats.isDirectory()) {
          const scan = await planLocalDirectory(localPath, target, token);
          plan = scan.files;
          for (const dir of scan.dirs) await mkdirp(destSftp, dir);
        } else {
          plan = [{
            from: localPath, to: target, size: stats.size,
            mode: stats.mode & 0o7777, mtime: Math.floor(stats.mtimeMs / 1000),
          }];
        }

        const totalBytes = plan.reduce((sum, f) => sum + f.size, 0);
        let sentBytes = 0;
        let fileIndex = 0;

        for (const file of plan) {
          if (token.isCancellationRequested) throw new vscode.CancellationError();
          fileIndex++;
          await mkdirp(destSftp, path.posix.dirname(file.to));
          await this.pipeUp(destSftp, file, token, chunk => {
            sentBytes += chunk;
            progress.report({
              increment: totalBytes > 0 ? (chunk / totalBytes) * 100 : 0,
              message: plan.length > 1
                ? `${fileIndex}/${plan.length} · ${path.basename(file.from)} · ${formatBytes(sentBytes)} of ${formatBytes(totalBytes)}`
                : `${formatBytes(sentBytes)} of ${formatBytes(totalBytes)}`,
            });
          });
        }
        return true;
      },
    );
  }

  /** Writes bytes already in memory — used for files dropped from outside the workspace. */
  async uploadBytes(
    name: string,
    bytes: Uint8Array,
    destHost: HostConfig,
    destDir: string,
  ): Promise<boolean> {
    const target = joinPosix(destDir, name);
    const destSftp = await this.ssh.getSftp(destHost.id, 'transfer');

    if (await exists(destSftp, target)) {
      const go = await vscode.window.showWarningMessage(
        `"${name}" already exists in ${destDir} on ${destHost.label}.`,
        { modal: true },
        'Overwrite',
      );
      if (go !== 'Overwrite') return false;
    }

    await mkdirp(destSftp, path.posix.dirname(target));
    await new Promise<void>((resolve, reject) => {
      const write = destSftp.createWriteStream(target);
      write.on('error', reject);
      write.on('close', () => resolve());
      write.end(Buffer.from(bytes));
    });
    return true;
  }

  /** Downloads a remote file or folder onto this machine. */
  async download(source: RemoteRef, sourceLabel: string, localDir: string): Promise<boolean> {
    const name   = path.posix.basename(source.path);
    const target = path.join(localDir, name);
    const sftp   = await this.ssh.getSftp(source.hostId, 'transfer');

    if (await localExists(target)) {
      const go = await vscode.window.showWarningMessage(
        `"${name}" already exists in ${localDir}.`,
        { modal: true },
        'Overwrite',
      );
      if (go !== 'Overwrite') return false;
    }

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading ${name} from ${sourceLabel}`,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: 'Scanning…' });
        let plan: PlannedFile[];

        if (source.isDirectory) {
          // Reuse the remote walker, then translate its POSIX destinations to
          // native paths so this works the same on Windows.
          const scan = await this.planDirectory(sftp, source.path, toPosix(target), token);
          plan = scan.files.map(f => ({ ...f, to: fromPosix(f.to) }));
          for (const dir of scan.dirs) await fsp.mkdir(fromPosix(dir), { recursive: true });
        } else {
          plan = [await this.planFile(sftp, source.path, target)];
          await fsp.mkdir(localDir, { recursive: true });
        }

        const totalBytes = plan.reduce((sum, f) => sum + f.size, 0);
        let received = 0;
        let fileIndex = 0;

        for (const file of plan) {
          if (token.isCancellationRequested) throw new vscode.CancellationError();
          fileIndex++;
          await fsp.mkdir(path.dirname(file.to), { recursive: true });
          await this.pipeDown(sftp, file, token, chunk => {
            received += chunk;
            progress.report({
              increment: totalBytes > 0 ? (chunk / totalBytes) * 100 : 0,
              message: plan.length > 1
                ? `${fileIndex}/${plan.length} · ${path.posix.basename(file.from)} · ${formatBytes(received)} of ${formatBytes(totalBytes)}`
                : `${formatBytes(received)} of ${formatBytes(totalBytes)}`,
            });
          });
        }
        return true;
      },
    );
  }

  private pipeDown(
    sftp: SFTPWrapper,
    file: PlannedFile,
    token: vscode.CancellationToken,
    onChunk: (bytes: number) => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const read  = sftp.createReadStream(file.from, { highWaterMark: 64 * 1024 });
      const write = fs.createWriteStream(file.to);

      const fail = (err: Error) => { read.destroy(); write.destroy(); sub.dispose(); reject(err); };
      const sub  = token.onCancellationRequested(() => fail(new vscode.CancellationError()));

      read.on('data',  (chunk: Buffer) => onChunk(chunk.length));
      read.on('error', fail);
      write.on('error', fail);
      write.on('finish', () => { sub.dispose(); resolve(); });

      read.pipe(write);
    });
  }

  private pipeUp(
    destSftp: SFTPWrapper,
    file: PlannedFile,
    token: vscode.CancellationToken,
    onChunk: (bytes: number) => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const read  = fs.createReadStream(file.from, { highWaterMark: 64 * 1024 });
      const write = destSftp.createWriteStream(file.to, { mode: file.mode });

      const fail = (err: Error) => { read.destroy(); write.destroy(); sub.dispose(); reject(err); };
      const sub  = token.onCancellationRequested(() => fail(new vscode.CancellationError()));

      read.on('data', (chunk: string | Buffer) => onChunk(chunk.length));
      read.on('error', fail);
      write.on('error', fail);
      write.on('close', () => {
        sub.dispose();
        if (file.mtime) destSftp.utimes(file.to, file.mtime, file.mtime, () => resolve());
        else resolve();
      });

      read.pipe(write);
    });
  }

  private async planFile(sftp: SFTPWrapper, from: string, to: string): Promise<PlannedFile> {
    const attrs = await stat(sftp, from);
    return { from, to, size: attrs.size ?? 0, mode: attrs.mode, mtime: attrs.mtime };
  }

  private async planDirectory(
    sftp: SFTPWrapper,
    root: string,
    target: string,
    token: vscode.CancellationToken,
  ): Promise<{ files: PlannedFile[]; dirs: string[] }> {
    const files: PlannedFile[] = [];
    const dirs: string[] = [target];
    const queue: Array<{ from: string; to: string }> = [{ from: root, to: target }];

    while (queue.length) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      const dir = queue.shift()!;
      for (const entry of await readdir(sftp, dir.from)) {
        const from = joinPosix(dir.from, entry.filename);
        const to   = joinPosix(dir.to,   entry.filename);
        const mode = entry.attrs.mode ?? 0;
        if ((mode & 0xF000) === 0x4000) {
          dirs.push(to);
          queue.push({ from, to });
        } else if ((mode & 0xF000) === 0xA000) {
          continue; // symlinks are skipped rather than silently dereferenced
        } else {
          files.push({ from, to, size: entry.attrs.size ?? 0, mode, mtime: entry.attrs.mtime });
        }
      }
    }
    return { files, dirs };
  }

  private pipeFile(
    srcSftp: SFTPWrapper,
    destSftp: SFTPWrapper,
    file: PlannedFile,
    token: vscode.CancellationToken,
    onChunk: (bytes: number) => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const read  = srcSftp.createReadStream(file.from, { highWaterMark: 64 * 1024 });
      // Strip the file-type bits — SFTP setstat only wants permission bits.
      const write = destSftp.createWriteStream(file.to, { mode: file.mode ? file.mode & 0o7777 : undefined });

      const fail = (err: Error) => { read.destroy(); write.destroy(); sub.dispose(); reject(err); };
      const sub  = token.onCancellationRequested(() => fail(new vscode.CancellationError()));

      read.on('data',  (chunk: Buffer) => onChunk(chunk.length));
      read.on('error', fail);
      write.on('error', fail);
      write.on('close', () => {
        sub.dispose();
        // Best effort: keeping mtime makes repeated syncs and `make` behave.
        if (file.mtime) {
          destSftp.utimes(file.to, file.mtime, file.mtime, () => resolve());
        } else {
          resolve();
        }
      });

      read.pipe(write);
    });
  }
}

/** Local-side twin of planDirectory — walks a folder on this machine. */
async function planLocalDirectory(
  root: string,
  target: string,
  token: vscode.CancellationToken,
): Promise<{ files: PlannedFile[]; dirs: string[] }> {
  const files: PlannedFile[] = [];
  const dirs: string[] = [target];
  const queue: Array<{ from: string; to: string }> = [{ from: root, to: target }];

  while (queue.length) {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const dir = queue.shift()!;
    for (const entry of await fsp.readdir(dir.from, { withFileTypes: true })) {
      const from = path.join(dir.from, entry.name);
      const to   = joinPosix(dir.to, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        dirs.push(to);
        queue.push({ from, to });
      } else if (entry.isFile()) {
        const s = await fsp.stat(from);
        files.push({
          from, to, size: s.size,
          mode: s.mode & 0o7777, mtime: Math.floor(s.mtimeMs / 1000),
        });
      }
    }
  }
  return { files, dirs };
}

// ── sftp promise wrappers ────────────────────────────────────────────────────

function stat(sftp: SFTPWrapper, p: string) {
  return new Promise<{ size?: number; mode?: number; mtime?: number }>((resolve, reject) => {
    sftp.stat(p, (err, s) => err ? reject(err) : resolve(s));
  });
}

function readdir(sftp: SFTPWrapper, dir: string) {
  return new Promise<Array<{ filename: string; attrs: { mode?: number; size?: number; mtime?: number } }>>(
    (resolve, reject) => {
      sftp.readdir(dir, (err, list) => err ? reject(err) : resolve(list ?? []));
    },
  );
}

function exists(sftp: SFTPWrapper, p: string): Promise<boolean> {
  return new Promise(resolve => sftp.stat(p, err => resolve(!err)));
}

async function localExists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true; } catch { return false; }
}

// The directory walker speaks POSIX. On Windows the download target does not,
// so paths cross that boundary here rather than in the walk itself.
function toPosix(p: string): string   { return p.replace(/\\/g, '/'); }
function fromPosix(p: string): string { return p.split('/').join(path.sep); }

/** mkdir -p over SFTP; an already-present directory is not an error. */
async function mkdirp(sftp: SFTPWrapper, dir: string): Promise<void> {
  if (!dir || dir === '/' || dir === '.') return;
  if (await exists(sftp, dir)) return;
  await mkdirp(sftp, path.posix.dirname(dir));
  await new Promise<void>(resolve => sftp.mkdir(dir, () => resolve()));
}

// ── quoting ──────────────────────────────────────────────────────────────────

function shQuote(s: string): string  { return s.replace(/'/g, `'\\''`); }
function psQuote(s: string): string  { return s.replace(/'/g, `''`);    }

export function joinPosix(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

import * as vscode from 'vscode';
import type { SshManager } from './sshManager';
import type { StatusBarManager } from './statusBar';

export const REMOTE_SCHEME = 'remoterun';

export function toRemoteUri(hostId: string, remotePath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: REMOTE_SCHEME, authority: hostId, path: remotePath });
}

export class RemoteFileSystemProvider implements vscode.FileSystemProvider {
  private readonly _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

  constructor(
    private readonly ssh: SshManager,
    private readonly bar: StatusBarManager,
  ) {}

  watch(): vscode.Disposable {
    return { dispose: () => {} };
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const sftp = await this.ssh.getSftp(uri.authority);
    return new Promise((resolve, reject) => {
      sftp.stat(uri.path, (err, stats) => {
        if (err) { reject(vscode.FileSystemError.FileNotFound(uri)); return; }
        const isDir = ((stats.mode ?? 0) & 0xF000) === 0x4000;
        resolve({
          type: isDir ? vscode.FileType.Directory : vscode.FileType.File,
          ctime: (stats.atime ?? 0) * 1000,
          mtime: (stats.mtime ?? 0) * 1000,
          size: stats.size ?? 0,
        });
      });
    });
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const sftp = await this.ssh.getSftp(uri.authority);
    return new Promise((resolve, reject) => {
      sftp.readdir(uri.path, (err, list) => {
        if (err) { reject(err); return; }
        resolve(list.map(entry => {
          const isDir = ((entry.attrs.mode ?? 0) & 0xF000) === 0x4000;
          return [entry.filename, isDir ? vscode.FileType.Directory : vscode.FileType.File];
        }));
      });
    });
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const sftp = await this.ssh.getSftp(uri.authority);
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = sftp.createReadStream(uri.path);
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
      stream.on('error', reject);
    });
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, _options: { create: boolean; overwrite: boolean }): Promise<void> {
    this.bar.setSyncing();
    try {
      const sftp = await this.ssh.getSftp(uri.authority);
      await new Promise<void>((resolve, reject) => {
        const stream = sftp.createWriteStream(uri.path);
        stream.on('error', reject);
        stream.on('close', resolve);
        stream.end(Buffer.from(content));
      });
      const name = uri.path.split('/').pop() ?? uri.path;
      this.bar.setSyncOk(name);
    } catch (err: any) {
      this.bar.setSyncError(err.message);
      throw vscode.FileSystemError.Unavailable(uri);
    }
  }

  async delete(uri: vscode.Uri, _options: { recursive: boolean }): Promise<void> {
    const sftp = await this.ssh.getSftp(uri.authority);
    return new Promise((resolve, reject) => {
      sftp.unlink(uri.path, err => err ? reject(err) : resolve());
    });
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, _options: { overwrite: boolean }): Promise<void> {
    const sftp = await this.ssh.getSftp(oldUri.authority);
    return new Promise((resolve, reject) => {
      sftp.rename(oldUri.path, newUri.path, err => err ? reject(err) : resolve());
    });
  }

  createDirectory(uri: vscode.Uri): Promise<void> {
    return this.ssh.getSftp(uri.authority).then(sftp => new Promise<void>((resolve, reject) => {
      sftp.mkdir(uri.path, err => err ? reject(err) : resolve());
    }));
  }

  fireDeleted(hostId: string, remotePath: string): void {
    this._emitter.fire([{
      type: vscode.FileChangeType.Deleted,
      uri: toRemoteUri(hostId, remotePath),
    }]);
  }
}

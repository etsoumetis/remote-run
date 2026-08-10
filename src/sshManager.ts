import { Client } from 'ssh2';
import type { SFTPWrapper } from 'ssh2';
import type { HostConfig } from './hostConfig';
import { homeDirCommand } from './utils';

// 'primary'  — interactive ops: sync-on-save, readdir, stat, small reads/writes.
// 'transfer' — bulk ops: media streaming, previews, host-to-host copies.
// Keeping them on separate SSH channels means a multi-minute video stream can
// never make Ctrl+S feel stuck behind it.
export type SftpChannel = 'primary' | 'transfer';

interface ActiveConn {
  client: Client;
  homeDir: string;
  sftp?: SFTPWrapper;         // persistent, reused across operations
  transferSftp?: SFTPWrapper; // opened lazily, only when bulk I/O happens
}

export class SshManager {
  private connections = new Map<string, ActiveConn>();
  private disconnectCb?: (hostId: string) => void;
  // client.end() still emits 'end', so a deliberate disconnect would otherwise
  // report itself as a dropped connection.
  private closing = new Set<string>();

  onDisconnect(cb: (hostId: string) => void): void {
    this.disconnectCb = cb;
  }

  async connect(host: HostConfig, password: string): Promise<string> {
    const existing = this.connections.get(host.id);
    if (existing) return existing.homeDir;

    const client  = await this.createClient(host, password);
    const homeDir = await this.resolveHomeDir(client, host);
    const conn: ActiveConn = { client, homeDir };
    this.connections.set(host.id, conn);

    const cleanup = () => {
      this.connections.delete(host.id);
      if (this.closing.delete(host.id)) return;
      this.disconnectCb?.(host.id);
    };
    client.on('end', cleanup).on('error', cleanup);

    return homeDir;
  }

  private createClient(host: HostConfig, password: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      client
        .on('ready', () => resolve(client))
        .on('error', reject)
        .connect({
          host: host.host,
          port: host.port ?? 22,
          username: host.username,
          password,
          readyTimeout: 15000,
        });
    });
  }

  private resolveHomeDir(client: Client, host: HostConfig): Promise<string> {
    const cmd      = homeDirCommand(host.remoteOs ?? 'linux');
    const fallback = host.remoteOs === 'windows'
      ? 'C:/Users/' + host.username
      : '/home/'    + host.username;

    return new Promise((resolve, reject) => {
      client.exec(cmd, (err, stream) => {
        if (err) { reject(err); return; }
        let out = '';
        stream.on('data', (chunk: Buffer) => { out += chunk.toString(); });
        stream.on('close', () => resolve(out.trim().replace(/\r/g, '') || fallback));
        stream.on('error', reject);
      });
    });
  }

  disconnect(hostId: string): void {
    const conn = this.connections.get(hostId);
    if (conn) {
      this.closing.add(hostId);
      conn.client.end();
      this.connections.delete(hostId);
    }
  }

  disconnectAll(): void {
    for (const [hostId, { client }] of this.connections) {
      this.closing.add(hostId);
      try { client.end(); } catch { /* ignore */ }
    }
    this.connections.clear();
  }

  isConnected(hostId: string): boolean {
    return this.connections.has(hostId);
  }

  getClient(hostId: string): Client | undefined {
    return this.connections.get(hostId)?.client;
  }

  getHomeDir(hostId: string): string | undefined {
    return this.connections.get(hostId)?.homeDir;
  }

  // Returns a cached SFTP session — creates one only on first call or after session loss.
  // Reusing the session eliminates ~100ms SSH channel setup overhead per sync.
  getSftp(hostId: string, channel: SftpChannel = 'primary'): Promise<SFTPWrapper> {
    const conn = this.connections.get(hostId);
    if (!conn) return Promise.reject(new Error('Not connected'));

    const cached = channel === 'transfer' ? conn.transferSftp : conn.sftp;
    if (cached) return Promise.resolve(cached);

    const store = (v: SFTPWrapper | undefined) => {
      if (channel === 'transfer') conn.transferSftp = v; else conn.sftp = v;
    };
    const current = () => channel === 'transfer' ? conn.transferSftp : conn.sftp;

    return new Promise((resolve, reject) => {
      conn.client.sftp((err, sftp) => {
        if (err) { reject(err); return; }
        store(sftp);
        // Clear cache if the SFTP session itself closes (e.g. server-side timeout)
        sftp.on('close', () => { if (current() === sftp) store(undefined); });
        sftp.on('error', () => { if (current() === sftp) store(undefined); });
        resolve(sftp);
      });
    });
  }

  exec(hostId: string, command: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const client = this.getClient(hostId);
    if (!client) return Promise.reject(new Error('Not connected'));
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) { reject(err); return; }
        let stdout = '', stderr = '';
        stream.on('data', (d: Buffer) => { stdout += d.toString(); });
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        stream.on('close', (code: number) => resolve({ code: code ?? 0, stdout, stderr }));
        stream.on('error', reject);
      });
    });
  }
}

import { Client } from 'ssh2';
import type { SFTPWrapper } from 'ssh2';
import type { HostConfig } from './hostConfig';
import { homeDirCommand } from './utils';

interface ActiveConn {
  client: Client;
  homeDir: string;
}

export class SshManager {
  private connections = new Map<string, ActiveConn>();
  private disconnectCb?: (hostId: string) => void;

  onDisconnect(cb: (hostId: string) => void): void {
    this.disconnectCb = cb;
  }

  async connect(host: HostConfig, password: string): Promise<string> {
    const existing = this.connections.get(host.id);
    if (existing) return existing.homeDir;

    const client = await this.createClient(host, password);
    const homeDir = await this.resolveHomeDir(client, host);

    this.connections.set(host.id, { client, homeDir });

    const cleanup = () => {
      this.connections.delete(host.id);
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
    const cmd = homeDirCommand(host.remoteOs ?? 'linux');
    const fallback = host.remoteOs === 'windows' ? 'C:/Users/' + host.username : '/home/' + host.username;

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
      conn.client.end();
      this.connections.delete(hostId);
    }
  }

  disconnectAll(): void {
    for (const { client } of this.connections.values()) {
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

  getSftp(hostId: string): Promise<SFTPWrapper> {
    const conn = this.connections.get(hostId);
    if (!conn) return Promise.reject(new Error('Not connected'));
    return new Promise((resolve, reject) => {
      conn.client.sftp((err, sftp) => {
        if (err) reject(err);
        else resolve(sftp);
      });
    });
  }
}

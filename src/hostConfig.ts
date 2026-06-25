import * as vscode from 'vscode';

export type RemoteOs = 'linux' | 'macos' | 'windows';

export interface HostConfig {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  remotePath: string;
  remoteOs: RemoteOs;
  useSudo: boolean;
}

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function getHosts(): HostConfig[] {
  // Read as any[] so we can safely back-fill fields added in later versions
  const raw = vscode.workspace.getConfiguration('remoteRun').get<any[]>('hosts', []);
  return raw.map(h => ({ ...h, remoteOs: (h.remoteOs ?? 'linux') as RemoteOs, useSudo: h.useSudo ?? false }));
}

async function saveHosts(hosts: HostConfig[]): Promise<void> {
  await vscode.workspace
    .getConfiguration('remoteRun')
    .update('hosts', hosts, vscode.ConfigurationTarget.Global);
}

export async function addHost(host: HostConfig): Promise<void> {
  const hosts = getHosts();
  hosts.push(host);
  await saveHosts(hosts);
}

export async function removeHost(id: string): Promise<void> {
  await saveHosts(getHosts().filter(h => h.id !== id));
}

import * as vscode from 'vscode';
import type { SFTPWrapper } from 'ssh2';
import { getHosts, HostConfig } from './hostConfig';
import { expandHome } from './utils';
import type { SshManager } from './sshManager';

export interface RemoteItem {
  name: string;
  fullPath: string;
  isDirectory: boolean;
}

export type HostNode = { kind: 'host'; config: HostConfig };
export type FileNode = { kind: 'file'; item: RemoteItem; hostId: string };
export type TreeNode = HostNode | FileNode;

export class RemoteRunTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onChange.event;

  constructor(private readonly ssh: SshManager) {}

  refresh(): void {
    this._onChange.fire();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    return node.kind === 'host' ? this.hostItem(node) : this.fileItem(node);
  }

  private hostItem(node: HostNode): vscode.TreeItem {
    const connected = this.ssh.isConnected(node.config.id);
    const item = new vscode.TreeItem(
      node.config.label,
      connected
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.description = `${node.config.username}@${node.config.host}:${node.config.port}`;
    item.tooltip = new vscode.MarkdownString(
      `**${node.config.label}**\n\n` +
      `\`${node.config.username}@${node.config.host}:${node.config.port}\`\n\n` +
      `Remote path: \`${node.config.remotePath}\`\n\n` +
      (connected ? '🟢 Connected' : '⚪ Disconnected'),
    );
    item.iconPath = connected
      ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'))
      : new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
    item.contextValue = connected ? 'host-connected' : 'host-disconnected';
    return item;
  }

  private fileItem(node: FileNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.item.name,
      node.item.isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.iconPath = node.item.isDirectory
      ? new vscode.ThemeIcon('folder')
      : new vscode.ThemeIcon('file');
    item.tooltip = node.item.fullPath;
    item.contextValue = node.item.isDirectory ? 'remote-dir' : 'remote-file';
    if (!node.item.isDirectory) {
      item.command = {
        command: 'remoteRun.openRemoteFile',
        title: 'Open',
        arguments: [node],
      };
    }
    return item;
  }

  async getChildren(parent?: TreeNode): Promise<TreeNode[]> {
    if (!parent) {
      return getHosts().map(config => ({ kind: 'host' as const, config }));
    }

    if (parent.kind === 'host') {
      if (!this.ssh.isConnected(parent.config.id)) return [];
      const homeDir = this.ssh.getHomeDir(parent.config.id);
      if (!homeDir) return [];
      const rootDir = expandHome(parent.config.remotePath, homeDir);
      try {
        const sftp = await this.ssh.getSftp(parent.config.id);
        return (await listDir(sftp, rootDir)).map(item => ({
          kind: 'file' as const,
          item,
          hostId: parent.config.id,
        }));
      } catch {
        return [];
      }
    }

    if (parent.kind === 'file' && parent.item.isDirectory) {
      if (!this.ssh.isConnected(parent.hostId)) return [];
      try {
        const sftp = await this.ssh.getSftp(parent.hostId);
        return (await listDir(sftp, parent.item.fullPath)).map(item => ({
          kind: 'file' as const,
          item,
          hostId: parent.hostId,
        }));
      } catch {
        return [];
      }
    }

    return [];
  }
}

function listDir(sftp: SFTPWrapper, dir: string): Promise<RemoteItem[]> {
  return new Promise(resolve => {
    sftp.readdir(dir, (err, list) => {
      if (err || !list) { resolve([]); return; }
      resolve(
        list
          .map(e => ({
            name: e.filename,
            fullPath: dir.replace(/\/$/, '') + '/' + e.filename,
            // 0xF000 = POSIX file type mask, 0x4000 = directory
            isDirectory: ((e.attrs.mode ?? 0) & 0xF000) === 0x4000,
          }))
          .sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            return a.name.localeCompare(b.name);
          }),
      );
    });
  });
}

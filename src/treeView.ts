import * as vscode from 'vscode';
import type { SFTPWrapper } from 'ssh2';
import { getHosts, HostConfig } from './hostConfig';
import { expandHome } from './utils';
import { mediaTypeFor } from './mediaTypes';
import type { SshManager } from './sshManager';
import type { RemoteRef } from './transferManager';

export interface RemoteItem {
  name: string;
  fullPath: string;
  isDirectory: boolean;
}

export type HostNode = { kind: 'host'; config: HostConfig };
export type FileNode = { kind: 'file'; item: RemoteItem; hostId: string };
export type TreeNode = HostNode | FileNode;

const DRAG_MIME = 'application/vnd.code.tree.remoterunhosts';
// Dragging out of the VS Code explorer yields uri-list; dropping from the OS
// file manager yields DataTransferFile entries instead.
const URI_LIST_MIME = 'text/uri-list';

export interface DroppedBytes { name: string; bytes: Uint8Array; }

export type DropHandler = (
  payload: { remote: RemoteRef[]; localPaths: string[]; inline: DroppedBytes[] },
  target: TreeNode,
) => Promise<void>;

export class RemoteRunTreeProvider
implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode> {
  private readonly _onChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onChange.event;

  readonly dragMimeTypes = [DRAG_MIME];
  readonly dropMimeTypes = [DRAG_MIME, URI_LIST_MIME, 'files'];

  private activeHostId?: string;
  private dropHandler?: DropHandler;

  constructor(private readonly ssh: SshManager) {}

  refresh(): void {
    this._onChange.fire();
  }

  setActiveHost(hostId: string | undefined): void {
    if (this.activeHostId === hostId) return;
    this.activeHostId = hostId;
    this.refresh();
  }

  onDrop(handler: DropHandler): void {
    this.dropHandler = handler;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    return node.kind === 'host' ? this.hostItem(node) : this.fileItem(node);
  }

  private hostItem(node: HostNode): vscode.TreeItem {
    const connected = this.ssh.isConnected(node.config.id);
    const active    = connected && node.config.id === this.activeHostId;

    const item = new vscode.TreeItem(
      node.config.label,
      connected
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.description = `${node.config.username}@${node.config.host}:${node.config.port}`
      + (active ? '  •  active' : '');
    item.tooltip = new vscode.MarkdownString(
      `**${node.config.label}**\n\n` +
      `\`${node.config.username}@${node.config.host}:${node.config.port}\`\n\n` +
      `Remote path: \`${node.config.remotePath}\`\n\n` +
      (connected ? '🟢 Connected' : '⚪ Disconnected') +
      (active ? '\n\n⭐ Run and sync-on-save target' : ''),
    );
    item.iconPath = !connected
      ? new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'))
      : active
        ? new vscode.ThemeIcon('star-full',     new vscode.ThemeColor('testing.iconPassed'))
        : new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'));

    // Distinct context values let the menus offer "Set as Active" only where it applies.
    item.contextValue = !connected ? 'host-disconnected'
      : active ? 'host-active'
      : 'host-connected';
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
      : new vscode.ThemeIcon(iconForFile(node.item.name));
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
      const rootDir = expandHome(parent.config.remotePath, homeDir, parent.config.remoteOs);
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

  // ── drag & drop ────────────────────────────────────────────────────────────

  handleDrag(source: readonly TreeNode[], data: vscode.DataTransfer): void {
    const refs: RemoteRef[] = source
      .filter((n): n is FileNode => n.kind === 'file')
      .map(n => ({ hostId: n.hostId, path: n.item.fullPath, isDirectory: n.item.isDirectory }));
    if (refs.length) data.set(DRAG_MIME, new vscode.DataTransferItem(refs));
  }

  async handleDrop(target: TreeNode | undefined, data: vscode.DataTransfer): Promise<void> {
    if (!target || !this.dropHandler) return;

    const remote = (data.get(DRAG_MIME)?.value as RemoteRef[] | undefined) ?? [];
    const localPaths: string[] = [];
    const inline: DroppedBytes[] = [];

    // Explorer drags arrive as a newline-separated URI list.
    const uriList = data.get(URI_LIST_MIME);
    if (uriList) {
      for (const line of (await uriList.asString()).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        try {
          const uri = vscode.Uri.parse(trimmed, true);
          if (uri.scheme === 'file') localPaths.push(uri.fsPath);
        } catch { /* not a URI we can act on */ }
      }
    }

    // OS drags arrive as files. Those backed by a real path are streamed from
    // disk; anything else has to come across as bytes.
    const files: vscode.DataTransferFile[] = [];
    data.forEach(item => {
      const file = item.asFile();
      if (file) files.push(file);
    });
    for (const file of files) {
      if (file.uri?.scheme === 'file') {
        if (!localPaths.includes(file.uri.fsPath)) localPaths.push(file.uri.fsPath);
      } else {
        inline.push({ name: file.name, bytes: await file.data() });
      }
    }

    if (!remote.length && !localPaths.length && !inline.length) return;
    await this.dropHandler({ remote, localPaths, inline }, target);
  }
}

function iconForFile(name: string): string {
  const media = mediaTypeFor(name);
  if (!media) return 'file';
  if (media.kind === 'pdf')   return 'file-pdf';
  if (media.kind === 'image') return 'file-media';
  if (media.kind === 'video') return 'device-camera-video';
  return 'unmute';
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

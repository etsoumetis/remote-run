import * as vscode from 'vscode';
import * as path from 'path';

import { HostConfig, RemoteOs, getHosts, addHost, removeHost, generateId } from './hostConfig';
import { CredentialStore } from './credentialStore';
import { SshManager } from './sshManager';
import { SyncManager } from './syncManager';
import { StatusBarManager } from './statusBar';
import { RemoteRunTreeProvider } from './treeView';
import type { HostNode, FileNode, TreeNode } from './treeView';
import { SshPseudoterminal, SshExecTerminal } from './sshTerminal';
import { expandHome, getRunCommand } from './utils';
import { RemoteFileSystemProvider, REMOTE_SCHEME, toRemoteUri } from './remoteFileSystem';

let activeHost: HostConfig | undefined;
let ssh: SshManager;
let creds: CredentialStore;
let sync: SyncManager;
let bar: StatusBarManager;
let tree: RemoteRunTreeProvider;
let remoteFs: RemoteFileSystemProvider;
let activeExecTerminal: { pty: SshExecTerminal; vsc: vscode.Terminal } | undefined;

export function activate(context: vscode.ExtensionContext) {
  ssh      = new SshManager();
  creds    = new CredentialStore(context.secrets);
  sync     = new SyncManager();
  bar      = new StatusBarManager();
  tree     = new RemoteRunTreeProvider(ssh);
  remoteFs = new RemoteFileSystemProvider(ssh, bar);

  ssh.onDisconnect(hostId => {
    if (activeHost?.id === hostId) {
      activeHost = undefined;
      bar.setDisconnected();
      setConnectedCtx(false);
    }
    tree.refresh();
    vscode.window.showWarningMessage('Remote Run: connection lost.');
  });

  context.subscriptions.push(
    bar,
    { dispose: () => ssh.disconnectAll() },

    vscode.workspace.registerFileSystemProvider(REMOTE_SCHEME, remoteFs, { isCaseSensitive: true }),
    vscode.window.registerTreeDataProvider('remoteRunHosts', tree),

    vscode.workspace.onDidSaveTextDocument(async doc => {
      // Remote-scheme files save through FileSystemProvider.writeFile — skip them here
      if (doc.uri.scheme === REMOTE_SCHEME) return;

      if (!activeHost) return;
      if (!vscode.workspace.getConfiguration('remoteRun').get<boolean>('syncOnSave', true)) return;
      bar.setSyncing();
      try {
        const sftp = await ssh.getSftp(activeHost.id);
        const remotePath = await sync.uploadFile(doc.fileName, activeHost, ssh.getHomeDir(activeHost.id)!, sftp);
        bar.setSyncOk(path.basename(remotePath));
      } catch (e: any) {
        bar.setSyncError(e.message);
      }
    }),

    vscode.commands.registerCommand('remoteRun.addHost',         cmdAddHost),
    vscode.commands.registerCommand('remoteRun.removeHost',      cmdRemoveHost),
    vscode.commands.registerCommand('remoteRun.editHost',        cmdEditHost),
    vscode.commands.registerCommand('remoteRun.connect',         cmdConnect),
    vscode.commands.registerCommand('remoteRun.disconnect',      cmdDisconnect),
    vscode.commands.registerCommand('remoteRun.connectHost',     (n: HostNode) => connectToHost(n.config)),
    vscode.commands.registerCommand('remoteRun.disconnectHost',  (n: HostNode) => disconnectFromHost(n.config)),
    vscode.commands.registerCommand('remoteRun.deleteHost',      cmdDeleteHost),
    vscode.commands.registerCommand('remoteRun.runFile',         cmdRunFile),
    vscode.commands.registerCommand('remoteRun.syncFile',        cmdSyncFile),
    vscode.commands.registerCommand('remoteRun.clearPassword',    cmdClearPassword),
    vscode.commands.registerCommand('remoteRun.refreshExplorer', () => tree.refresh()),
    vscode.commands.registerCommand('remoteRun.openRemoteFile',  cmdOpenRemoteFile),
    vscode.commands.registerCommand('remoteRun.openTerminal',    cmdOpenTerminal),
    vscode.commands.registerCommand('remoteRun.newFolder',       cmdNewFolder),
    vscode.commands.registerCommand('remoteRun.newFile',         cmdNewFile),
    vscode.commands.registerCommand('remoteRun.renameRemoteItem',cmdRenameRemoteItem),
    vscode.commands.registerCommand('remoteRun.deleteRemoteItem',cmdDeleteRemoteItem),
    vscode.commands.registerCommand('remoteRun.stopFile',        cmdStopFile),

    vscode.window.onDidCloseTerminal(t => {
      if (activeExecTerminal?.vsc === t) {
        setRunningCtx(false);
        activeExecTerminal = undefined;
      }
    }),
  );
}

// ─── Host management ─────────────────────────────────────────────────────────

async function cmdAddHost() {
  const label    = await ask('Host label', 'My Server');
  if (!label) return;
  const host     = await ask('Hostname or IP', '192.168.1.100');
  if (!host) return;
  const portStr  = await ask('SSH port', '22');
  if (portStr === undefined) return;
  const username = await ask('Username', '', 'pi, ubuntu, admin, arduino...');
  if (!username) return;

  const osPick = await vscode.window.showQuickPick([
    { label: '$(vm) Linux',       description: 'Raspberry Pi, Ubuntu, Debian, and others', value: 'linux'   as RemoteOs },
    { label: '$(apple) macOS',    description: 'macOS with Remote Login enabled',           value: 'macos'   as RemoteOs },
    { label: '$(window) Windows', description: 'Windows with OpenSSH Server',               value: 'windows' as RemoteOs },
  ], { placeHolder: 'Remote operating system' });
  if (!osPick) return;

  const remotePath = await ask(
    'Remote working directory (optional)',
    '',
    'Leave empty for home directory, e.g. /home/pi/projects',
  );
  if (remotePath === undefined) return;

  const sudoPick = await vscode.window.showQuickPick([
    { label: '$(circle-slash) No',                                  value: false },
    { label: '$(shield) Yes — use SSH password for sudo automatically', value: true  },
  ], { placeHolder: 'Run scripts with sudo? (needed for GPIO, hardware access, etc.)' });
  if (!sudoPick) return;

  await addHost({
    id: generateId(),
    label,
    host,
    port: parseInt(portStr, 10) || 22,
    username,
    remotePath: remotePath.trim() || '~',
    remoteOs: osPick.value,
    useSudo: sudoPick.value,
  });
  tree.refresh();
  vscode.window.showInformationMessage(`Host "${label}" added.`);
}

async function cmdEditHost(node?: HostNode) {
  let host: HostConfig | undefined = node?.config;

  if (!host) {
    const hosts = getHosts();
    if (!hosts.length) { vscode.window.showInformationMessage('No hosts configured.'); return; }
    const pick = await vscode.window.showQuickPick(
      hosts.map(h => ({ label: h.label, description: `${h.username}@${h.host}`, host: h })),
      { placeHolder: 'Select host to edit' },
    );
    if (!pick) return;
    host = pick.host;
  }

  const label      = await ask('Host label',                                    host.label);
  if (!label) return;
  const hostAddr   = await ask('Hostname or IP',                                host.host);
  if (!hostAddr) return;
  const portStr    = await ask('SSH port',                                       String(host.port));
  if (portStr === undefined) return;
  const username   = await ask('Username',                                       host.username);
  if (!username) return;

  const osPick = await vscode.window.showQuickPick([
    { label: '$(vm) Linux',       description: 'Raspberry Pi, Ubuntu, Debian, and others', value: 'linux'   as RemoteOs },
    { label: '$(apple) macOS',    description: 'macOS with Remote Login enabled',           value: 'macos'   as RemoteOs },
    { label: '$(window) Windows', description: 'Windows with OpenSSH Server',               value: 'windows' as RemoteOs },
  ], { placeHolder: 'Remote operating system' });
  if (!osPick) return;

  const remotePath = await ask(
    'Remote working directory (optional)',
    host.remotePath === '~' ? '' : host.remotePath,
    'Leave empty for home directory',
  );
  if (remotePath === undefined) return;

  const sudoPick = await vscode.window.showQuickPick([
    { label: '$(circle-slash) No',                                      value: false },
    { label: '$(shield) Yes — use SSH password for sudo automatically', value: true  },
  ], { placeHolder: 'Run scripts with sudo? (needed for GPIO, hardware access, etc.)' });
  if (!sudoPick) return;

  const hosts = getHosts().map(h =>
    h.id === host!.id
      ? { ...h, remoteOs: osPick.value, label, host: hostAddr,
          port: parseInt(portStr, 10) || 22, username,
          remotePath: remotePath.trim() || '~', useSudo: sudoPick.value }
      : h,
  );
  await vscode.workspace
    .getConfiguration('remoteRun')
    .update('hosts', hosts, vscode.ConfigurationTarget.Global);

  tree.refresh();
  vscode.window.showInformationMessage(`Host "${label}" updated.`);
}

async function cmdRemoveHost() {
  const hosts = getHosts();
  if (!hosts.length) { vscode.window.showInformationMessage('No hosts configured.'); return; }
  const pick = await vscode.window.showQuickPick(
    hosts.map(h => ({ label: h.label, description: `${h.username}@${h.host}:${h.port}`, host: h })),
    { placeHolder: 'Select host to remove' },
  );
  if (!pick) return;
  await doDeleteHost(pick.host);
}

async function cmdDeleteHost(node?: HostNode) {
  if (!node?.config) return;
  await doDeleteHost(node.config);
}

async function doDeleteHost(host: HostConfig) {
  const ok = await vscode.window.showWarningMessage(
    `Remove "${host.label}"?`, { modal: true }, 'Remove',
  );
  if (ok !== 'Remove') return;
  if (activeHost?.id === host.id) disconnectFromHost(host, false);
  await removeHost(host.id);
  await creds.clearPassword(host.id);
  tree.refresh();
  vscode.window.showInformationMessage(`Host "${host.label}" removed.`);
}

// ─── Connection ──────────────────────────────────────────────────────────────

async function cmdConnect() {
  const hosts = getHosts();
  if (!hosts.length) {
    const go = await vscode.window.showInformationMessage('No hosts configured.', 'Add Host');
    if (go === 'Add Host') await cmdAddHost();
    return;
  }
  const pick = await vscode.window.showQuickPick(
    hosts.map(h => ({
      label: `$(remote) ${h.label}`,
      description: `${h.username}@${h.host}:${h.port}`,
      host: h,
    })),
    { placeHolder: 'Select host to connect' },
  );
  if (!pick) return;
  await connectToHost(pick.host);
}

async function connectToHost(host: HostConfig) {
  if (activeHost && activeHost.id !== host.id) disconnectFromHost(activeHost, false);

  if (ssh.isConnected(host.id)) {
    activeHost = host;
    bar.setConnected(host.label);
    setConnectedCtx(true);
    tree.refresh();
    return;
  }

  let password = await creds.getPassword(host.id);
  if (!password) {
    password = await vscode.window.showInputBox({
      prompt: `Password for ${host.username}@${host.host}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (password === undefined) return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Connecting to ${host.label}…`, cancellable: false },
    async () => {
      try {
        await ssh.connect(host, password!);
        await creds.setPassword(host.id, password!);
        activeHost = host;
        bar.setConnected(host.label);
        setConnectedCtx(true);
        tree.refresh();
        vscode.window.showInformationMessage(`Connected to ${host.label}.`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Connection failed: ${e.message}`);
      }
    },
  );
}

async function cmdDisconnect() {
  if (!activeHost) return;
  disconnectFromHost(activeHost);
}

function disconnectFromHost(host: HostConfig, showMsg = true): void {
  if (activeExecTerminal) {
    activeExecTerminal.pty.kill();
    setRunningCtx(false);
    activeExecTerminal = undefined;
  }
  ssh.disconnect(host.id);
  if (activeHost?.id === host.id) {
    activeHost = undefined;
    bar.setDisconnected();
    setConnectedCtx(false);
  }
  tree.refresh();
  if (showMsg) vscode.window.showInformationMessage(`Disconnected from ${host.label}.`);
}

// ─── Run / Sync ──────────────────────────────────────────────────────────────

async function cmdRunFile() {
  if (!activeHost) {
    const go = await vscode.window.showWarningMessage('Not connected to any host.', 'Connect');
    if (go === 'Connect') await cmdConnect();
    return;
  }

  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || doc.isUntitled) { vscode.window.showWarningMessage('Save the file before running.'); return; }
  if (doc.isDirty) {
    const saved = await doc.save();
    if (!saved) return;
  }

  const client  = ssh.getClient(activeHost.id);
  const homeDir = ssh.getHomeDir(activeHost.id);
  if (!client || !homeDir) { vscode.window.showErrorMessage('Connection lost. Please reconnect.'); return; }

  // Determine remote path — remote files are already there, local files need syncing first
  let remotePath: string;
  if (doc.uri.scheme === REMOTE_SCHEME) {
    if (doc.uri.authority !== activeHost.id) {
      vscode.window.showWarningMessage('This file belongs to a different host. Connect to that host first.');
      return;
    }
    remotePath = doc.uri.path;
  } else {
    bar.setSyncing();
    try {
      const sftp = await ssh.getSftp(activeHost.id);
      remotePath = await sync.uploadFile(doc.fileName, activeHost, homeDir, sftp);
      bar.setSyncOk(path.basename(remotePath));
    } catch (e: any) {
      bar.setSyncError(e.message);
      vscode.window.showErrorMessage(`Sync failed: ${e.message}`);
      return;
    }
  }

  // Determine the run command from file extension
  const filePath = doc.uri.scheme === REMOTE_SCHEME ? doc.uri.path : doc.fileName;
  const ext = path.posix.extname(filePath).toLowerCase() || path.extname(filePath).toLowerCase();
  const custom = vscode.workspace.getConfiguration('remoteRun').get<Record<string, string>>('runCommands', {});
  const cmd = getRunCommand(ext, custom, activeHost.remoteOs ?? 'linux');
  if (!cmd) {
    vscode.window.showWarningMessage(`No run command for "${ext}". Add one in Settings → Remote Run → Run Commands.`);
    return;
  }

  let fullCmd = `${cmd} "${remotePath}"`;
  if (activeHost.useSudo) {
    const password = await creds.getPassword(activeHost.id);
    if (password) {
      const pw = password.replace(/'/g, "'\\''");
      fullCmd = `printf '%s\\n' '${pw}' | sudo -S -p '' ${cmd} "${remotePath}"`;
    }
  }

  const filename = remotePath.split('/').pop() ?? remotePath;
  const pty = new SshExecTerminal(client, fullCmd);
  const terminal = vscode.window.createTerminal({ name: `Run: ${filename} [${activeHost.label}]`, pty });
  activeExecTerminal = { pty, vsc: terminal };
  pty.onDidClose(() => {
    if (activeExecTerminal?.vsc === terminal) {
      setRunningCtx(false);
      activeExecTerminal = undefined;
    }
  });
  setRunningCtx(true);
  terminal.show();
}

function cmdStopFile(): void {
  activeExecTerminal?.pty.kill();
  setRunningCtx(false);
  activeExecTerminal = undefined;
}

async function cmdSyncFile() {
  if (!activeHost) { vscode.window.showWarningMessage('Not connected to any host.'); return; }
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || doc.isUntitled) { vscode.window.showWarningMessage('Open a saved file first.'); return; }
  if (doc.uri.scheme === REMOTE_SCHEME) {
    // Trigger a save which goes through FileSystemProvider.writeFile
    await doc.save();
    return;
  }
  bar.setSyncing();
  try {
    const sftp = await ssh.getSftp(activeHost.id);
    const remotePath = await sync.uploadFile(doc.fileName, activeHost, ssh.getHomeDir(activeHost.id)!, sftp);
    bar.setSyncOk(path.basename(remotePath));
    vscode.window.showInformationMessage('File synced.');
  } catch (e: any) {
    bar.setSyncError(e.message);
    vscode.window.showErrorMessage(`Sync failed: ${e.message}`);
  }
}

// ─── Misc ────────────────────────────────────────────────────────────────────

async function cmdClearPassword() {
  const hosts = getHosts();
  if (!hosts.length) { vscode.window.showInformationMessage('No hosts configured.'); return; }
  const pick = await vscode.window.showQuickPick(
    hosts.map(h => ({ label: h.label, description: `${h.username}@${h.host}`, id: h.id })),
    { placeHolder: 'Select host to clear saved password' },
  );
  if (!pick) return;
  await creds.clearPassword(pick.id);
  vscode.window.showInformationMessage(`Saved password cleared for "${pick.label}".`);
}

async function cmdOpenRemoteFile(node: FileNode) {
  if (!node?.item || node.item.isDirectory) return;
  try {
    const uri = toRemoteUri(node.hostId, node.item.fullPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch (e: any) {
    vscode.window.showErrorMessage(`Cannot open file: ${e.message}`);
  }
}

// ─── SSH Terminal ─────────────────────────────────────────────────────────────

async function cmdOpenTerminal(node?: HostNode) {
  const host = node?.config ?? activeHost;
  if (!host) { vscode.window.showWarningMessage('Not connected to any host.'); return; }
  const client = ssh.getClient(host.id);
  if (!client) { vscode.window.showWarningMessage(`Not connected to ${host.label}.`); return; }
  const pty      = new SshPseudoterminal(client);
  const terminal = vscode.window.createTerminal({ name: `SSH: ${host.label}`, pty });
  terminal.show();
}

// ─── Remote file operations ───────────────────────────────────────────────────

async function cmdNewFolder(node?: TreeNode) {
  const { hostId, dir } = resolveDir(node);
  if (!hostId) { vscode.window.showWarningMessage('Not connected to any host.'); return; }
  const name = await vscode.window.showInputBox({ prompt: 'New folder name', placeHolder: 'my-folder', ignoreFocusOut: true });
  if (!name?.trim()) return;
  try {
    const sftp = await ssh.getSftp(hostId);
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(`${dir}/${name.trim()}`, err => err ? reject(err) : resolve());
    });
    tree.refresh();
  } catch (e: any) {
    vscode.window.showErrorMessage(`Failed to create folder: ${e.message}`);
  }
}

async function cmdNewFile(node?: TreeNode) {
  const { hostId, dir } = resolveDir(node);
  if (!hostId) { vscode.window.showWarningMessage('Not connected to any host.'); return; }
  const name = await vscode.window.showInputBox({ prompt: 'New file name', placeHolder: 'script.py', ignoreFocusOut: true });
  if (!name?.trim()) return;
  const remotePath = `${dir}/${name.trim()}`;
  try {
    const sftp = await ssh.getSftp(hostId);
    await new Promise<void>((resolve, reject) => {
      sftp.open(remotePath, 'w', (err, handle) => {
        if (err) { reject(err); return; }
        sftp.close(handle, err2 => err2 ? reject(err2) : resolve());
      });
    });
    tree.refresh();
  } catch (e: any) {
    vscode.window.showErrorMessage(`Failed to create file: ${e.message}`);
  }
}

async function cmdRenameRemoteItem(node?: FileNode) {
  if (!node?.item) return;
  const newName = await vscode.window.showInputBox({
    prompt: 'New name',
    value: node.item.name,
    ignoreFocusOut: true,
    validateInput: v => !v.trim() ? 'Name cannot be empty' : v.includes('/') ? 'Name cannot contain /' : undefined,
  });
  if (!newName || newName.trim() === node.item.name) return;
  const dir     = node.item.fullPath.slice(0, node.item.fullPath.lastIndexOf('/'));
  const newPath = `${dir}/${newName.trim()}`;
  try {
    const sftp = await ssh.getSftp(node.hostId);
    await new Promise<void>((resolve, reject) => {
      sftp.rename(node.item.fullPath, newPath, err => err ? reject(err) : resolve());
    });
    tree.refresh();
  } catch (e: any) {
    vscode.window.showErrorMessage(`Rename failed: ${e.message}`);
  }
}

async function cmdDeleteRemoteItem(node?: FileNode) {
  if (!node?.item) return;
  const ok = await vscode.window.showWarningMessage(
    `Delete "${node.item.name}"?`, { modal: true }, 'Delete',
  );
  if (ok !== 'Delete') return;
  try {
    const sftp = await ssh.getSftp(node.hostId);
    await new Promise<void>((resolve, reject) => {
      if (node.item.isDirectory) {
        sftp.rmdir(node.item.fullPath, err => err ? reject(err) : resolve());
      } else {
        sftp.unlink(node.item.fullPath, err => err ? reject(err) : resolve());
      }
    });
    remoteFs.fireDeleted(node.hostId, node.item.fullPath);
    tree.refresh();
  } catch (e: any) {
    const hint = node.item.isDirectory ? ' (directory must be empty)' : '';
    vscode.window.showErrorMessage(`Failed to delete: ${e.message}${hint}`);
  }
}

function resolveDir(node?: TreeNode): { hostId: string | undefined; dir: string } {
  if (!node) {
    if (!activeHost) return { hostId: undefined, dir: '/' };
    const home = ssh.getHomeDir(activeHost.id) ?? '/';
    return { hostId: activeHost.id, dir: expandHome(activeHost.remotePath, home, activeHost.remoteOs) };
  }
  if (node.kind === 'host') {
    if (!ssh.isConnected(node.config.id)) return { hostId: undefined, dir: '/' };
    const home = ssh.getHomeDir(node.config.id) ?? '/';
    return { hostId: node.config.id, dir: expandHome(node.config.remotePath, home, node.config.remoteOs) };
  }
  // FileNode — use the directory itself, or parent if it's a file
  if (node.item.isDirectory) {
    return { hostId: node.hostId, dir: node.item.fullPath };
  }
  const parent = node.item.fullPath.slice(0, node.item.fullPath.lastIndexOf('/')) || '/';
  return { hostId: node.hostId, dir: parent };
}

// ─── Helper ──────────────────────────────────────────────────────────────────

function ask(p: string, value?: string, placeHolder?: string): Thenable<string | undefined> {
  return vscode.window.showInputBox({ prompt: p, value, placeHolder, ignoreFocusOut: true });
}

function setConnectedCtx(connected: boolean): void {
  vscode.commands.executeCommand('setContext', 'remoteRun.connected', connected);
}

function setRunningCtx(running: boolean): void {
  vscode.commands.executeCommand('setContext', 'remoteRun.running', running);
}

export function deactivate() {
  ssh?.disconnectAll();
}

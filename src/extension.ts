import * as vscode from 'vscode';
import * as path from 'path';

import { HostConfig, RemoteOs, getHosts, addHost, removeHost, generateId } from './hostConfig';
import { CredentialStore } from './credentialStore';
import { SshManager } from './sshManager';
import { SyncManager } from './syncManager';
import { StatusBarManager } from './statusBar';
import { RemoteRunTreeProvider } from './treeView';
import type { HostNode, FileNode, TreeNode, DroppedBytes } from './treeView';
import { SshPseudoterminal, SshExecTerminal } from './sshTerminal';
import { expandHome, getRunCommand } from './utils';
import { RemoteFileSystemProvider, REMOTE_SCHEME, toRemoteUri } from './remoteFileSystem';
import { PreviewCache } from './previewCache';
import { MediaServer } from './mediaServer';
import { PreviewManager } from './previewPanel';
import { TransferManager, joinPosix, type RemoteRef } from './transferManager';

interface RunHandle { pty: SshExecTerminal; vsc: vscode.Terminal; host: HostConfig; }

let activeHost: HostConfig | undefined;
let ssh: SshManager;
let creds: CredentialStore;
let sync: SyncManager;
let bar: StatusBarManager;
let tree: RemoteRunTreeProvider;
let treeViewRef: vscode.TreeView<TreeNode>;
let remoteFs: RemoteFileSystemProvider;
let cache: PreviewCache;
let mediaServer: MediaServer;
let preview: PreviewManager;
let transfer: TransferManager;

/** One run per host: starting a script on the Pi should not cancel one on a VM. */
const runs = new Map<string, RunHandle>();
let clipboard: RemoteRef[] = [];

export function activate(context: vscode.ExtensionContext) {
  ssh         = new SshManager();
  creds       = new CredentialStore(context.secrets);
  sync        = new SyncManager();
  bar         = new StatusBarManager();
  tree        = new RemoteRunTreeProvider(ssh);
  remoteFs    = new RemoteFileSystemProvider(ssh, bar);
  cache       = new PreviewCache(context, ssh);
  mediaServer = new MediaServer(ssh);
  preview     = new PreviewManager(context, cache, mediaServer);
  transfer    = new TransferManager(ssh);

  treeViewRef = vscode.window.createTreeView('remoteRunHosts', {
    treeDataProvider: tree,
    dragAndDropController: tree,
    canSelectMany: true,
  });
  tree.onDrop(handleDrop);

  ssh.onDisconnect(hostId => {
    onHostGone(hostId);
    vscode.window.showWarningMessage('Remote Run: connection lost.');
  });

  context.subscriptions.push(
    bar,
    treeViewRef,
    cache,
    mediaServer,
    preview,
    { dispose: () => ssh.disconnectAll() },

    vscode.workspace.registerFileSystemProvider(REMOTE_SCHEME, remoteFs, { isCaseSensitive: true }),

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

    vscode.commands.registerCommand('remoteRun.addHost',          cmdAddHost),
    vscode.commands.registerCommand('remoteRun.removeHost',       cmdRemoveHost),
    vscode.commands.registerCommand('remoteRun.editHost',         cmdEditHost),
    vscode.commands.registerCommand('remoteRun.connect',          cmdConnect),
    vscode.commands.registerCommand('remoteRun.disconnect',       cmdDisconnect),
    vscode.commands.registerCommand('remoteRun.disconnectAll',    cmdDisconnectAll),
    vscode.commands.registerCommand('remoteRun.connectHost',      (n: HostNode) => connectToHost(n.config)),
    vscode.commands.registerCommand('remoteRun.disconnectHost',   (n: HostNode) => disconnectFromHost(n.config)),
    vscode.commands.registerCommand('remoteRun.setActiveHost',    (n: HostNode) => setActiveHost(n.config)),
    vscode.commands.registerCommand('remoteRun.switchActiveHost', cmdSwitchActiveHost),
    vscode.commands.registerCommand('remoteRun.deleteHost',       cmdDeleteHost),
    vscode.commands.registerCommand('remoteRun.runFile',          cmdRunFile),
    vscode.commands.registerCommand('remoteRun.syncFile',         cmdSyncFile),
    vscode.commands.registerCommand('remoteRun.clearPassword',    cmdClearPassword),
    vscode.commands.registerCommand('remoteRun.refreshExplorer',  () => tree.refresh()),
    vscode.commands.registerCommand('remoteRun.openRemoteFile',   cmdOpenRemoteFile),
    vscode.commands.registerCommand('remoteRun.previewRemoteFile',cmdPreviewRemoteFile),
    vscode.commands.registerCommand('remoteRun.openAsText',       cmdOpenAsText),
    vscode.commands.registerCommand('remoteRun.openTerminal',     cmdOpenTerminal),
    vscode.commands.registerCommand('remoteRun.newFolder',        cmdNewFolder),
    vscode.commands.registerCommand('remoteRun.newFile',          cmdNewFile),
    vscode.commands.registerCommand('remoteRun.renameRemoteItem', cmdRenameRemoteItem),
    vscode.commands.registerCommand('remoteRun.deleteRemoteItem', cmdDeleteRemoteItem),
    vscode.commands.registerCommand('remoteRun.copyRemoteItem',   cmdCopyRemoteItem),
    vscode.commands.registerCommand('remoteRun.pasteRemoteItem',  cmdPasteRemoteItem),
    vscode.commands.registerCommand('remoteRun.sendToHost',       cmdSendToHost),
    vscode.commands.registerCommand('remoteRun.uploadFiles',      cmdUploadFiles),
    vscode.commands.registerCommand('remoteRun.uploadFolder',     cmdUploadFolder),
    vscode.commands.registerCommand('remoteRun.sendLocalToHost',  cmdSendLocalToHost),
    vscode.commands.registerCommand('remoteRun.downloadToComputer', cmdDownloadToComputer),
    vscode.commands.registerCommand('remoteRun.openExternally',   cmdOpenExternally),
    vscode.commands.registerCommand('remoteRun.clearPreviewCache',cmdClearPreviewCache),
    vscode.commands.registerCommand('remoteRun.stopFile',         cmdStopFile),

    vscode.window.onDidCloseTerminal(t => {
      for (const [hostId, run] of runs) {
        if (run.vsc === t) { runs.delete(hostId); refreshRunningCtx(); }
      }
    }),
  );

  // Housekeeping only — must never delay activation.
  cache.startupCleanup();
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

  const updated: HostConfig = {
    ...host, remoteOs: osPick.value, label, host: hostAddr,
    port: parseInt(portStr, 10) || 22, username,
    remotePath: remotePath.trim() || '~', useSudo: sudoPick.value,
  };
  const hosts = getHosts().map(h => h.id === host!.id ? updated : h);
  await vscode.workspace
    .getConfiguration('remoteRun')
    .update('hosts', hosts, vscode.ConfigurationTarget.Global);

  if (activeHost?.id === updated.id) { activeHost = updated; bar.setConnected(updated.label, connectedCount()); }
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
  if (ssh.isConnected(host.id)) disconnectFromHost(host, false);
  await removeHost(host.id);
  await creds.clearPassword(host.id);
  tree.refresh();
  vscode.window.showInformationMessage(`Host "${host.label}" removed.`);
}

// ─── Connection ──────────────────────────────────────────────────────────────

function connectedHosts(): HostConfig[] {
  return getHosts().filter(h => ssh.isConnected(h.id));
}

function connectedCount(): number {
  return connectedHosts().length;
}

function hostById(hostId: string): HostConfig | undefined {
  return getHosts().find(h => h.id === hostId);
}

function hostLabel(hostId: string): string {
  return hostById(hostId)?.label ?? hostId;
}

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
      detail: ssh.isConnected(h.id) ? '$(check) already connected' : undefined,
      host: h,
    })),
    { placeHolder: 'Select host to connect' },
  );
  if (!pick) return;
  await connectToHost(pick.host);
}

/**
 * Connects without touching any other session. Several hosts stay up at once —
 * the "active" one is only the target for Run and sync-on-save.
 */
async function connectToHost(host: HostConfig) {
  if (ssh.isConnected(host.id)) {
    setActiveHost(host);
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
        setActiveHost(host);
        vscode.window.showInformationMessage(`Connected to ${host.label}.`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Connection failed: ${e.message}`);
      }
    },
  );
}

function setActiveHost(host: HostConfig | undefined): void {
  activeHost = host;
  if (host) bar.setConnected(host.label, connectedCount());
  else bar.setDisconnected();
  tree.setActiveHost(host?.id);
  setConnectedCtx(!!host);
  tree.refresh();
}

async function cmdSwitchActiveHost() {
  const connected = connectedHosts();
  if (!connected.length) { await cmdConnect(); return; }

  type Item = vscode.QuickPickItem & { host?: HostConfig; action?: 'connect' | 'disconnect' | 'disconnectAll' };
  const items: Item[] = connected.map(h => ({
    label: `${h.id === activeHost?.id ? '$(star-full)' : '$(remote)'} ${h.label}`,
    description: `${h.username}@${h.host}:${h.port}`,
    detail: h.id === activeHost?.id ? 'Active — Run and sync-on-save target' : undefined,
    host: h,
  }));

  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(add) Connect another host…', action: 'connect' },
  );
  if (activeHost) {
    items.push({ label: `$(debug-disconnect) Disconnect ${activeHost.label}`, action: 'disconnect' });
  }
  if (connected.length > 1) {
    items.push({ label: '$(close-all) Disconnect all', action: 'disconnectAll' });
  }

  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Active host' });
  if (!pick) return;

  if (pick.action === 'connect')       { await cmdConnect(); return; }
  if (pick.action === 'disconnect')    { if (activeHost) disconnectFromHost(activeHost); return; }
  if (pick.action === 'disconnectAll') { await cmdDisconnectAll(); return; }
  if (pick.host) setActiveHost(pick.host);
}

async function cmdDisconnect() {
  if (!activeHost) return;
  disconnectFromHost(activeHost);
}

async function cmdDisconnectAll() {
  const connected = connectedHosts();
  for (const host of connected) disconnectFromHost(host, false);
  if (connected.length) {
    vscode.window.showInformationMessage(`Disconnected from ${connected.length} host(s).`);
  }
}

function disconnectFromHost(host: HostConfig, showMsg = true): void {
  ssh.disconnect(host.id);
  onHostGone(host.id);
  if (showMsg) vscode.window.showInformationMessage(`Disconnected from ${host.label}.`);
}

/** Shared teardown for both deliberate disconnects and dropped connections. */
function onHostGone(hostId: string): void {
  const run = runs.get(hostId);
  if (run) { run.pty.kill(); runs.delete(hostId); refreshRunningCtx(); }

  mediaServer.unpublishHost(hostId);
  preview.closeForHost(hostId);
  clipboard = clipboard.filter(ref => ref.hostId !== hostId);
  setClipboardCtx();

  if (activeHost?.id === hostId) {
    // Fall back to another live session rather than dropping to "disconnected".
    setActiveHost(connectedHosts()[0]);
  } else {
    if (activeHost) bar.setConnected(activeHost.label, connectedCount());
    tree.refresh();
  }
}

// ─── Run / Sync ──────────────────────────────────────────────────────────────

async function cmdRunFile() {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || doc.isUntitled) { vscode.window.showWarningMessage('Save the file before running.'); return; }

  // A remote file always runs on the host it lives on, whichever host is active.
  let target: HostConfig | undefined;
  if (doc.uri.scheme === REMOTE_SCHEME) {
    target = hostById(doc.uri.authority);
    if (!target) { vscode.window.showErrorMessage('This file belongs to a host that no longer exists.'); return; }
    if (!ssh.isConnected(target.id)) {
      const go = await vscode.window.showWarningMessage(`Not connected to ${target.label}.`, 'Connect');
      if (go !== 'Connect') return;
      await connectToHost(target);
      if (!ssh.isConnected(target.id)) return;
    }
  } else {
    if (!activeHost) {
      const go = await vscode.window.showWarningMessage('Not connected to any host.', 'Connect');
      if (go === 'Connect') await cmdConnect();
      return;
    }
    target = activeHost;
  }

  if (doc.isDirty) {
    const saved = await doc.save();
    if (!saved) return;
  }

  const client  = ssh.getClient(target.id);
  const homeDir = ssh.getHomeDir(target.id);
  if (!client || !homeDir) { vscode.window.showErrorMessage('Connection lost. Please reconnect.'); return; }

  // Determine remote path — remote files are already there, local files need syncing first
  let remotePath: string;
  if (doc.uri.scheme === REMOTE_SCHEME) {
    remotePath = doc.uri.path;
  } else {
    bar.setSyncing();
    try {
      const sftp = await ssh.getSftp(target.id);
      remotePath = await sync.uploadFile(doc.fileName, target, homeDir, sftp);
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
  const cmd = getRunCommand(ext, custom, target.remoteOs ?? 'linux');
  if (!cmd) {
    vscode.window.showWarningMessage(`No run command for "${ext}". Add one in Settings → Remote Run → Run Commands.`);
    return;
  }

  let fullCmd = `${cmd} "${remotePath}"`;
  if (target.useSudo) {
    const password = await creds.getPassword(target.id);
    if (password) {
      const pw = password.replace(/'/g, "'\\''");
      fullCmd = `printf '%s\\n' '${pw}' | sudo -S -p '' ${cmd} "${remotePath}"`;
    }
  }

  // Replace any run already going on this host — one script per host at a time.
  runs.get(target.id)?.pty.kill();

  const filename = remotePath.split('/').pop() ?? remotePath;
  const pty = new SshExecTerminal(client, fullCmd);
  const terminal = vscode.window.createTerminal({ name: `Run: ${filename} [${target.label}]`, pty });
  const handle: RunHandle = { pty, vsc: terminal, host: target };
  runs.set(target.id, handle);

  pty.onDidClose(() => {
    if (runs.get(target!.id) === handle) { runs.delete(target!.id); refreshRunningCtx(); }
  });
  refreshRunningCtx();
  terminal.show();
}

async function cmdStopFile(): Promise<void> {
  if (runs.size === 0) return;

  if (runs.size === 1) {
    const [hostId, run] = [...runs][0];
    run.pty.kill();
    runs.delete(hostId);
    refreshRunningCtx();
    return;
  }

  const pick = await vscode.window.showQuickPick(
    [...runs].map(([hostId, run]) => ({ label: `$(debug-stop) ${run.vsc.name}`, hostId })),
    { placeHolder: 'Stop which run?' },
  );
  if (!pick) return;
  runs.get(pick.hostId)?.pty.kill();
  runs.delete(pick.hostId);
  refreshRunningCtx();
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

async function cmdClearPreviewCache() {
  await cache.clear();
  vscode.window.showInformationMessage('Preview cache cleared.');
}

// ─── Opening files ───────────────────────────────────────────────────────────

async function cmdOpenRemoteFile(node: FileNode) {
  if (!node?.item || node.item.isDirectory) return;
  if (PreviewManager.canPreview(node.item.name)) {
    await cmdPreviewRemoteFile(node);
    return;
  }
  await openAsTextDocument(node.hostId, node.item.fullPath);
}

async function cmdPreviewRemoteFile(node: FileNode) {
  if (!node?.item || node.item.isDirectory) return;
  try {
    await preview.show(node.hostId, node.item.fullPath, hostLabel(node.hostId));
  } catch (e: any) {
    if (e instanceof vscode.CancellationError) return;
    vscode.window.showErrorMessage(`Cannot preview file: ${e.message}`);
  }
}

/** Escape hatch for things like .svg, where the source is often what you want. */
async function cmdOpenAsText(node: FileNode) {
  if (!node?.item || node.item.isDirectory) return;
  await openAsTextDocument(node.hostId, node.item.fullPath);
}

async function openAsTextDocument(hostId: string, remotePath: string): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(toRemoteUri(hostId, remotePath));
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
      sftp.mkdir(joinPosix(dir, name.trim()), err => err ? reject(err) : resolve());
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
  const remotePath = joinPosix(dir, name.trim());
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
  const newPath = joinPosix(dir, newName.trim());
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

// ─── Transfer between hosts ───────────────────────────────────────────────────

/** Tree commands receive (clickedNode, allSelectedNodes) when canSelectMany is on. */
function selectedFiles(node?: FileNode, selection?: FileNode[]): RemoteRef[] {
  const nodes = selection?.length ? selection : node ? [node] : [];
  return nodes
    .filter(n => n?.kind === 'file')
    .map(n => ({ hostId: n.hostId, path: n.item.fullPath, isDirectory: n.item.isDirectory }));
}

function cmdCopyRemoteItem(node?: FileNode, selection?: FileNode[]): void {
  const refs = selectedFiles(node, selection);
  if (!refs.length) return;
  clipboard = refs;
  setClipboardCtx();
  const what = refs.length === 1 ? path.posix.basename(refs[0].path) : `${refs.length} items`;
  vscode.window.setStatusBarMessage(`$(clippy) Copied ${what}`, 3000);
}

async function cmdPasteRemoteItem(node?: TreeNode): Promise<void> {
  if (!clipboard.length) { vscode.window.showInformationMessage('Nothing copied yet.'); return; }
  const { hostId, dir } = resolveDir(node);
  if (!hostId) { vscode.window.showWarningMessage('Select a connected host or folder to paste into.'); return; }
  await performTransfer(clipboard, hostId, dir);
}

/** Explicit "send elsewhere" for when the destination is not visible in the tree. */
async function cmdSendToHost(node?: FileNode, selection?: FileNode[]): Promise<void> {
  const refs = selectedFiles(node, selection);
  if (!refs.length) return;

  const targets = connectedHosts().filter(h => h.id !== refs[0].hostId);
  if (!targets.length) {
    vscode.window.showWarningMessage('Connect a second host first — there is nowhere to send to.');
    return;
  }

  const pick = await vscode.window.showQuickPick(
    targets.map(h => ({ label: `$(remote) ${h.label}`, description: `${h.username}@${h.host}`, host: h })),
    { placeHolder: 'Send to which host?' },
  );
  if (!pick) return;

  const home = ssh.getHomeDir(pick.host.id) ?? '/';
  const suggested = expandHome(pick.host.remotePath, home, pick.host.remoteOs);
  const dir = await vscode.window.showInputBox({
    prompt: `Destination folder on ${pick.host.label}`,
    value: suggested,
    ignoreFocusOut: true,
  });
  if (!dir?.trim()) return;

  await performTransfer(refs, pick.host.id, dir.trim());
}

async function handleDrop(
  payload: { remote: RemoteRef[]; localPaths: string[]; inline: DroppedBytes[] },
  target: TreeNode,
): Promise<void> {
  const { hostId, dir } = resolveDir(target);
  if (!hostId) return;
  if (payload.remote.length) await performTransfer(payload.remote, hostId, dir);
  if (payload.localPaths.length || payload.inline.length) {
    await performUpload(payload.localPaths, payload.inline, hostId, dir);
  }
}

/**
 * Pick files on this machine and push them to a host.
 *
 * Files and folders need separate commands: on Windows and Linux a native
 * dialog cannot select both, and asking for both silently degrades to a
 * folder-only picker — which makes picking a single image impossible.
 */
function cmdUploadFiles(node?: TreeNode): Promise<void> {
  return uploadViaDialog(node, false);
}

function cmdUploadFolder(node?: TreeNode): Promise<void> {
  return uploadViaDialog(node, true);
}

async function uploadViaDialog(node: TreeNode | undefined, folders: boolean): Promise<void> {
  const { hostId, dir } = resolveDir(node);
  if (!hostId) {
    const go = await vscode.window.showWarningMessage('Not connected to any host.', 'Connect');
    if (go === 'Connect') await cmdConnect();
    return;
  }

  const picked = await vscode.window.showOpenDialog({
    canSelectMany: true,
    canSelectFiles: !folders,
    canSelectFolders: folders,
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    openLabel: folders ? 'Upload folder' : 'Upload',
    title: `Upload to ${hostLabel(hostId)}:${dir}`,
  });
  if (!picked?.length) return;

  await performUpload(picked.map(u => u.fsPath), [], hostId, dir);
}

/** Entry point from the VS Code explorer's right-click menu. */
async function cmdSendLocalToHost(uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
  const chosen = (uris?.length ? uris : uri ? [uri] : [])
    .filter(u => u.scheme === 'file')
    .map(u => u.fsPath);

  const paths = chosen.length
    ? chosen
    : vscode.window.activeTextEditor?.document.uri.scheme === 'file'
      ? [vscode.window.activeTextEditor.document.uri.fsPath]
      : [];

  if (!paths.length) { vscode.window.showWarningMessage('Select a file on this machine first.'); return; }

  const connected = connectedHosts();
  if (!connected.length) {
    const go = await vscode.window.showWarningMessage('Not connected to any host.', 'Connect');
    if (go === 'Connect') await cmdConnect();
    return;
  }

  const pick = connected.length === 1 ? { host: connected[0] } : await vscode.window.showQuickPick(
    connected.map(h => ({ label: `$(remote) ${h.label}`, description: `${h.username}@${h.host}`, host: h })),
    { placeHolder: 'Upload to which host?' },
  );
  if (!pick) return;

  const home = ssh.getHomeDir(pick.host.id) ?? '/';
  const dir = await vscode.window.showInputBox({
    prompt: `Destination folder on ${pick.host.label}`,
    value: expandHome(pick.host.remotePath, home, pick.host.remoteOs),
    ignoreFocusOut: true,
  });
  if (!dir?.trim()) return;

  await performUpload(paths, [], pick.host.id, dir.trim());
}

/** Remote → this computer, for files and whole folders. */
async function cmdDownloadToComputer(node?: FileNode, selection?: FileNode[]): Promise<void> {
  const refs = selectedFiles(node, selection);
  if (!refs.length) return;

  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFiles: false,
    canSelectFolders: true,
    openLabel: 'Download here',
    title: 'Choose a folder on this computer',
  });
  if (!picked?.length) return;
  const destDir = picked[0].fsPath;

  let done = 0;
  try {
    for (const ref of refs) {
      if (!ssh.isConnected(ref.hostId)) {
        vscode.window.showWarningMessage(`Skipped ${path.posix.basename(ref.path)} — host disconnected.`);
        continue;
      }
      if (await transfer.download(ref, hostLabel(ref.hostId), destDir)) done++;
    }
  } catch (e: any) {
    if (!(e instanceof vscode.CancellationError)) {
      vscode.window.showErrorMessage(`Download failed: ${e.message}`);
    }
  }

  if (done) {
    const open = await vscode.window.showInformationMessage(
      `Downloaded ${done} item(s) to ${destDir}`, 'Reveal in Explorer',
    );
    if (open === 'Reveal in Explorer') {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(destDir));
    }
  }
}

/**
 * Last resort for formats with no in-editor viewer (.docx, .zip, .stl…). The
 * file is cached locally, then handed to whatever the OS uses for it.
 */
async function cmdOpenExternally(node?: FileNode): Promise<void> {
  if (!node?.item || node.item.isDirectory) return;
  try {
    const stat  = await cache.stat(node.hostId, node.item.fullPath);
    const local = await cache.fetch(node.hostId, node.item.fullPath, stat, node.item.name);
    await vscode.env.openExternal(vscode.Uri.file(local));
  } catch (e: any) {
    if (e instanceof vscode.CancellationError) return;
    vscode.window.showErrorMessage(`Cannot open file: ${e.message}`);
  }
}

async function performUpload(
  localPaths: string[],
  inline: DroppedBytes[],
  destHostId: string,
  destDir: string,
): Promise<void> {
  const destHost = hostById(destHostId);
  if (!destHost) return;
  if (!ssh.isConnected(destHostId)) {
    vscode.window.showWarningMessage(`Not connected to ${destHost.label}.`);
    return;
  }

  let uploaded = 0;
  try {
    for (const localPath of localPaths) {
      if (await transfer.uploadLocal(localPath, destHost, destDir)) uploaded++;
    }
    for (const item of inline) {
      if (await transfer.uploadBytes(item.name, item.bytes, destHost, destDir)) uploaded++;
    }
  } catch (e: any) {
    if (!(e instanceof vscode.CancellationError)) {
      vscode.window.showErrorMessage(`Upload failed: ${e.message}`);
    }
  }

  if (uploaded) {
    tree.refresh();
    vscode.window.showInformationMessage(
      `Uploaded ${uploaded} item(s) to ${destHost.label}:${destDir}`,
    );
  }
}

async function performTransfer(refs: RemoteRef[], destHostId: string, destDir: string): Promise<void> {
  const destHost = hostById(destHostId);
  if (!destHost) return;
  if (!ssh.isConnected(destHostId)) {
    vscode.window.showWarningMessage(`Not connected to ${destHost.label}.`);
    return;
  }

  let copied = 0;
  try {
    for (const ref of refs) {
      if (!ssh.isConnected(ref.hostId)) {
        vscode.window.showWarningMessage(`Skipped ${path.posix.basename(ref.path)} — source host is disconnected.`);
        continue;
      }
      if (await transfer.copy(ref, destHost, destDir)) copied++;
    }
  } catch (e: any) {
    if (!(e instanceof vscode.CancellationError)) {
      vscode.window.showErrorMessage(`Transfer failed: ${e.message}`);
    }
  }

  if (copied) {
    tree.refresh();
    const from = refs[0].hostId === destHostId ? '' : ` from ${hostLabel(refs[0].hostId)}`;
    vscode.window.showInformationMessage(
      `Copied ${copied} item(s)${from} to ${destHost.label}:${destDir}`,
    );
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

function refreshRunningCtx(): void {
  vscode.commands.executeCommand('setContext', 'remoteRun.running', runs.size > 0);
}

function setClipboardCtx(): void {
  vscode.commands.executeCommand('setContext', 'remoteRun.hasClipboard', clipboard.length > 0);
}

export function deactivate() {
  ssh?.disconnectAll();
}

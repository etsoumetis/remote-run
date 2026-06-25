import * as vscode from 'vscode';

export class StatusBarManager implements vscode.Disposable {
  private readonly hostItem: vscode.StatusBarItem;
  private readonly syncItem: vscode.StatusBarItem;
  private timer?: NodeJS.Timeout;

  constructor() {
    this.hostItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.syncItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.setDisconnected();
  }

  setConnected(label: string): void {
    this.hostItem.text = `$(remote) ${label}`;
    this.hostItem.tooltip = 'Remote Run: connected — click to disconnect';
    this.hostItem.command = 'remoteRun.disconnect';
    this.hostItem.show();
    this.syncItem.text = '$(circle-large-outline) Idle';
    this.syncItem.tooltip = undefined;
    this.syncItem.show();
  }

  setDisconnected(): void {
    this.hostItem.text = '$(remote-explorer) Remote Run';
    this.hostItem.tooltip = 'Remote Run: click to connect';
    this.hostItem.command = 'remoteRun.connect';
    this.hostItem.show();
    this.syncItem.hide();
  }

  setSyncing(): void {
    this.clearTimer();
    this.syncItem.text = '$(sync~spin) Syncing…';
    this.syncItem.tooltip = undefined;
  }

  setSyncOk(filename?: string): void {
    this.clearTimer();
    this.syncItem.text = filename ? `$(check) Synced → ${filename}` : '$(check) Synced';
    this.timer = setTimeout(() => {
      this.syncItem.text = '$(circle-large-outline) Idle';
    }, 3000);
  }

  setSyncError(msg: string): void {
    this.clearTimer();
    this.syncItem.text = '$(error) Sync failed';
    this.syncItem.tooltip = msg;
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
  }

  dispose(): void {
    this.clearTimer();
    this.hostItem.dispose();
    this.syncItem.dispose();
  }
}

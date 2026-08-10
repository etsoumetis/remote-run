import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { mediaTypeFor, shouldStream, type MediaKind } from './mediaTypes';
import { PreviewCache, formatBytes } from './previewCache';
import type { MediaServer } from './mediaServer';

interface OpenPreview {
  panel: vscode.WebviewPanel;
  streamId?: string;
  hostId: string;
}

interface InitMessage {
  kind: MediaKind;
  src: string;
  name: string;
  size: number;
  mime: string;
  streamed: boolean;
  pdfLib?: string;
  pdfWorker?: string;
  pdfFonts?: string;
}

export class PreviewManager implements vscode.Disposable {
  private readonly open = new Map<string, OpenPreview>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly cache: PreviewCache,
    private readonly server: MediaServer,
  ) {}

  /** True when this file has a viewer — callers use it to pick preview vs text editor. */
  static canPreview(filename: string): boolean {
    return mediaTypeFor(filename) !== undefined;
  }

  async show(hostId: string, remotePath: string, hostLabel: string): Promise<void> {
    const name = path.posix.basename(remotePath);
    const type = mediaTypeFor(name);
    if (!type) return;

    const key = `${hostId}\u0000${remotePath}`;
    const existing = this.open.get(key);
    if (existing) { existing.panel.reveal(); return; }

    const cfg  = vscode.workspace.getConfiguration('remoteRun');
    const stat = await this.cache.stat(hostId, remotePath);

    const pdfThreshold = cfg.get<number>('preview.pdfStreamThresholdMB', 4) * 1024 * 1024;
    const streamed = cfg.get<boolean>('preview.streaming', true)
      && shouldStream(type.kind, stat.size, pdfThreshold);

    if (!streamed) {
      const capMb = cfg.get<number>('preview.maxDownloadMB', 64);
      if (stat.size > capMb * 1024 * 1024) {
        const go = await vscode.window.showWarningMessage(
          `"${name}" is ${formatBytes(stat.size)}. It has to be downloaded in full before it can be shown.`,
          { modal: true },
          'Download and open',
        );
        if (go !== 'Download and open') return;
      }
    }

    const panel = vscode.window.createWebviewPanel(
      'remoteRun.preview',
      `${name} — ${hostLabel}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: type.kind === 'video' || type.kind === 'audio',
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'media'),
          vscode.Uri.file(this.cache.directory),
        ],
      },
    );

    const record: OpenPreview = { panel, hostId };
    this.open.set(key, record);
    panel.onDidDispose(() => {
      if (record.streamId) this.server.unpublish(record.streamId);
      this.open.delete(key);
    });

    try {
      let src: string;
      let streamOrigin: string | undefined;

      if (streamed) {
        const published = await this.server.publish({
          hostId, remotePath, size: stat.size, mime: type.mime,
        });
        record.streamId = published.id;
        src = published.url;
        streamOrigin = published.origin;
      } else {
        const local = await this.cache.fetch(hostId, remotePath, stat, name);
        src = panel.webview.asWebviewUri(vscode.Uri.file(local)).toString();
      }

      // Mutable: the retry path rewrites src/streamed and re-sends it.
      const init: InitMessage = {
        kind: type.kind, src, name, size: stat.size, mime: type.mime, streamed,
      };

      if (type.kind === 'pdf') {
        const asset = (...p: string[]) => panel.webview
          .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', ...p)).toString();
        init.pdfLib    = asset('pdfjs', 'pdf.min.mjs');
        init.pdfWorker = asset('pdfjs', 'pdf.worker.min.mjs');
        init.pdfFonts  = asset('pdfjs', 'standard_fonts') + '/';
      }

      panel.webview.onDidReceiveMessage(msg => {
        if (msg?.type === 'ready') { panel.webview.postMessage({ type: 'init', ...init }); }
        if (msg?.type === 'saveCopy') { void this.saveCopy(hostId, remotePath, name); }
        if (msg?.type === 'openExternally') { void this.openExternally(hostId, remotePath, name); }
        if (msg?.type === 'retryCached') { void retryCached(msg.code, msg.detail); }
        if (msg?.type === 'error' && typeof msg.message === 'string') {
          vscode.window.showErrorMessage(`Preview: ${msg.message}`);
        }
      });

      // Streaming can fail for reasons that have nothing to do with the file —
      // a refused origin, a dropped range request. Falling back to a downloaded
      // copy recovers those without the user having to understand any of it.
      const retryCached = async (code: number, detail: string) => {
        if (!init.streamed) return;
        try {
          const local = await this.cache.fetch(hostId, remotePath, stat, name);
          if (record.streamId) { this.server.unpublish(record.streamId); record.streamId = undefined; }
          init.streamed = false;
          init.src = panel.webview.asWebviewUri(vscode.Uri.file(local)).toString();
          panel.webview.postMessage({ type: 'init', ...init });
        } catch (err) {
          if (err instanceof vscode.CancellationError) { panel.dispose(); return; }
          vscode.window.showErrorMessage(
            `Could not play "${name}" (media error ${code}${detail ? `: ${detail}` : ''}): ${(err as Error).message}`,
          );
        }
      };

      panel.webview.html = this.html(panel.webview, streamOrigin);
    } catch (err) {
      panel.dispose();
      if (err instanceof vscode.CancellationError) return;
      throw err;
    }
  }

  /** Hands the file to whatever the OS uses for it, via the temporary cache. */
  private async openExternally(hostId: string, remotePath: string, name: string): Promise<void> {
    try {
      const stat  = await this.cache.stat(hostId, remotePath);
      const local = await this.cache.fetch(hostId, remotePath, stat, name);
      await vscode.env.openExternal(vscode.Uri.file(local));
    } catch (err) {
      if (err instanceof vscode.CancellationError) return;
      vscode.window.showErrorMessage(`Cannot open file: ${(err as Error).message}`);
    }
  }

  /** Fallback for formats the embedded players cannot decode (e.g. HEVC in .mkv). */
  private async saveCopy(hostId: string, remotePath: string, name: string): Promise<void> {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), name)),
      saveLabel: 'Save a copy',
    });
    if (!target) return;
    try {
      const stat  = await this.cache.stat(hostId, remotePath);
      const local = await this.cache.fetch(hostId, remotePath, stat, name);
      await vscode.workspace.fs.copy(vscode.Uri.file(local), target, { overwrite: true });
      vscode.window.showInformationMessage(`Saved to ${target.fsPath}`);
    } catch (err) {
      if (err instanceof vscode.CancellationError) return;
      vscode.window.showErrorMessage(`Save failed: ${(err as Error).message}`);
    }
  }

  closeForHost(hostId: string): void {
    for (const record of [...this.open.values()]) {
      if (record.hostId === hostId) record.panel.dispose();
    }
  }

  private html(webview: vscode.Webview, streamOrigin?: string): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const media = (f: string) => webview
      .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f)).toString();

    const extra = streamOrigin ?? '';
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} ${extra} data: blob:`,
      `media-src ${webview.cspSource} ${extra} blob:`,
      // cspSource is needed alongside the nonce so the dynamic import() of
      // pdf.min.mjs is allowed; nonces do not propagate to imported modules.
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `connect-src ${webview.cspSource} ${extra} blob:`,
      `worker-src blob:`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('preview.css')}">
<title>Preview</title>
</head>
<body>
<div id="toolbar" hidden></div>
<div id="stage"><div id="spinner">Loading…</div></div>
<script nonce="${nonce}" src="${media('preview.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const record of this.open.values()) record.panel.dispose();
    this.open.clear();
  }
}

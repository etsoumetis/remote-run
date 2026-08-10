import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import type { SshManager } from './sshManager';

interface Entry {
  hostId: string;
  remotePath: string;
  size: number;
  mime: string;
}

/**
 * Loopback HTTP server that translates browser byte-range requests into SFTP
 * ranged reads.
 *
 * This is what keeps previewing a 2 GB video off a Raspberry Pi cheap: the Pi
 * only ever reads the ranges the user actually watches, nothing is written to
 * the local disk, and peak memory is one socket buffer per active stream.
 * pdf.js uses the same mechanism to pull individual pages out of a large PDF.
 *
 * The server is started on the first stream request and torn down with the
 * extension. Access is gated by a 192-bit token embedded in the URL path, and
 * the listener is bound to 127.0.0.1 only.
 */
export class MediaServer implements vscode.Disposable {
  private server?: http.Server;
  private starting?: Promise<number>;
  private origin?: string;
  private readonly token = crypto.randomBytes(24).toString('hex');
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly ssh: SshManager) {}

  /** Registers a file and returns a URL the webview can point an element at. */
  async publish(entry: Entry): Promise<{ id: string; url: string; origin: string }> {
    const id = crypto.randomBytes(12).toString('hex');
    this.entries.set(id, entry);

    const port = await this.ensureStarted();
    // asExternalUri makes this work when the extension host is remote — VS Code
    // sets up the port tunnel for us. On a normal desktop it is a no-op.
    const external = await vscode.env.asExternalUri(
      vscode.Uri.parse(`http://127.0.0.1:${port}/${this.token}/${id}`),
    );
    const url    = external.toString();
    const origin = `${external.scheme}://${external.authority}`;
    this.origin  = origin;
    return { id, url, origin };
  }

  unpublish(id: string): void {
    this.entries.delete(id);
  }

  /** Drops every entry belonging to a host — called when that host disconnects. */
  unpublishHost(hostId: string): void {
    for (const [id, e] of this.entries) {
      if (e.hostId === hostId) this.entries.delete(id);
    }
  }

  get cspOrigin(): string | undefined {
    return this.origin;
  }

  private ensureStarted(): Promise<number> {
    const running = this.server?.address();
    if (running && typeof running === 'object') return Promise.resolve(running.port);
    if (this.starting) return this.starting;

    this.starting = new Promise<number>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      // Long media reads over a slow link must not be killed by the default
      // 5s headers timeout / 2min socket timeout.
      server.headersTimeout = 30_000;
      server.requestTimeout = 0;
      server.timeout        = 0;
      server.keepAliveTimeout = 60_000;

      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    this.starting.catch(() => { this.starting = undefined; });
    return this.starting;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const entry = this.resolve(req.url ?? '');

    // pdf.js issues a cross-origin fetch from the webview, so preflight and the
    // range headers it reads back both have to be allowed explicitly.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (!entry) { res.writeHead(404); res.end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }

    const range = parseRange(req.headers.range, entry.size);
    if (range === 'invalid') {
      res.writeHead(416, { 'Content-Range': `bytes */${entry.size}` });
      res.end();
      return;
    }

    const start = range ? range.start : 0;
    const end   = range ? range.end   : Math.max(entry.size - 1, 0);
    const length = entry.size === 0 ? 0 : end - start + 1;

    res.writeHead(range ? 206 : 200, {
      'Content-Type':   entry.mime,
      'Content-Length': String(length),
      'Accept-Ranges':  'bytes',
      'Cache-Control':  'no-store',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${entry.size}` } : {}),
    });

    if (req.method === 'HEAD' || length === 0) { res.end(); return; }

    const sftp = await this.ssh.getSftp(entry.hostId, 'transfer');
    const stream = sftp.createReadStream(entry.remotePath, {
      start,
      end,
      highWaterMark: 64 * 1024,
    });

    // Seeking in a <video> aborts the in-flight request. Tearing the SFTP read
    // down immediately is what stops a scrubbing user from piling up dozens of
    // live reads on a 512 MB device.
    const abort = () => stream.destroy();
    res.on('close', abort);
    stream.on('error', () => { res.destroy(); });
    stream.pipe(res);
  }

  private resolve(url: string): Entry | undefined {
    const parts = url.split('?')[0].split('/').filter(Boolean);
    if (parts.length !== 2) return undefined;
    const [token, id] = parts;
    if (!safeEqual(token, this.token)) return undefined;
    return this.entries.get(id);
  }

  dispose(): void {
    this.entries.clear();
    this.server?.closeAllConnections?.();
    this.server?.close();
    this.server = undefined;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | undefined | 'invalid' {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return 'invalid';

  const [, rawStart, rawEnd] = m;
  let start: number, end: number;

  if (rawStart === '') {
    // Suffix form: "bytes=-500" means the last 500 bytes.
    const suffix = parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(size - suffix, 0);
    end   = size - 1;
  } else {
    start = parseInt(rawStart, 10);
    end   = rawEnd === '' ? size - 1 : parseInt(rawEnd, 10);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
  if (start > end || start >= size) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

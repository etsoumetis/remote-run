import * as vscode from 'vscode';
import { Client } from 'ssh2';
import type { ClientChannel } from 'ssh2';

export class SshPseudoterminal implements vscode.Pseudoterminal {
  private readonly _onDidWrite  = new vscode.EventEmitter<string>();
  private readonly _onDidClose  = new vscode.EventEmitter<void | number>();
  readonly onDidWrite  = this._onDidWrite.event;
  readonly onDidClose  = this._onDidClose.event;

  private stream?: ClientChannel;

  constructor(private readonly client: Client) {}

  open(dimensions: vscode.TerminalDimensions | undefined): void {
    this.client.shell(
      {
        rows:  dimensions?.rows    ?? 24,
        cols:  dimensions?.columns ?? 80,
        term: 'xterm-256color',
      },
      (err, stream) => {
        if (err) {
          this._onDidWrite.fire(`\r\nFailed to open shell: ${err.message}\r\n`);
          this._onDidClose.fire(1);
          return;
        }
        this.stream = stream;
        stream.on('data',          (d: Buffer) => this._onDidWrite.fire(d.toString()));
        stream.stderr.on('data',   (d: Buffer) => this._onDidWrite.fire(d.toString()));
        stream.on('close',         ()          => this._onDidClose.fire());
      },
    );
  }

  handleInput(data: string): void {
    this.stream?.write(data);
  }

  setDimensions(d: vscode.TerminalDimensions): void {
    this.stream?.setWindow(d.rows, d.columns, 0, 0);
  }

  close(): void {
    this.stream?.end();
  }
}

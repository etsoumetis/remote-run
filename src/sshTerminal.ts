import * as vscode from 'vscode';
import { Client } from 'ssh2';
import type { ClientChannel } from 'ssh2';

// Used for running scripts — exec with PTY so we get color output and can kill the process.
export class SshExecTerminal implements vscode.Pseudoterminal {
  private stream?: ClientChannel;
  private readonly _onDidWrite = new vscode.EventEmitter<string>();
  private readonly _onDidClose = new vscode.EventEmitter<void | number>();
  readonly onDidWrite  = this._onDidWrite.event;
  readonly onDidClose  = this._onDidClose.event;

  constructor(
    private readonly client: Client,
    private readonly command: string,
  ) {}

  open(dimensions: vscode.TerminalDimensions | undefined): void {
    this.client.exec(this.command, {
      pty: { rows: dimensions?.rows ?? 24, cols: dimensions?.columns ?? 80, term: 'xterm-256color' },
    }, (err, stream) => {
      if (err) {
        this._onDidWrite.fire(`\r\nFailed to run: ${err.message}\r\n`);
        this._onDidClose.fire(1);
        return;
      }
      this.stream = stream;
      stream.on('data',        (d: Buffer) => this._onDidWrite.fire(d.toString()));
      stream.stderr.on('data', (d: Buffer) => this._onDidWrite.fire(d.toString()));
      stream.on('close',       (code: number) => this._onDidClose.fire(code ?? 0));
    });
  }

  handleInput(data: string): void { this.stream?.write(data); }

  setDimensions(d: vscode.TerminalDimensions): void {
    this.stream?.setWindow(d.rows, d.columns, 0, 0);
  }

  kill(): void {
    this.stream?.write('\x03'); // Ctrl+C → SIGINT to foreground process
  }

  close(): void { this.kill(); }
}

export class SshPseudoterminal implements vscode.Pseudoterminal {
  private readonly _onDidWrite  = new vscode.EventEmitter<string>();
  private readonly _onDidClose  = new vscode.EventEmitter<void | number>();
  readonly onDidWrite  = this._onDidWrite.event;
  readonly onDidClose  = this._onDidClose.event;

  private stream?: ClientChannel;

  constructor(
    private readonly client: Client,
    private readonly initialCommand?: string,
  ) {}

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
        if (this.initialCommand) {
          stream.write(this.initialCommand + '\r');
        }
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

import * as path from 'path';
import * as vscode from 'vscode';
import { Client } from 'ssh2';
import type { HostConfig } from './hostConfig';
import { getRunCommand, remotePathFor } from './utils';

export class RunManager {
  async runFile(
    client: Client,
    localPath: string,
    host: HostConfig,
    homeDir: string,
    output: vscode.OutputChannel,
    overrideRemotePath?: string,
  ): Promise<void> {
    const ext = path.extname(localPath).toLowerCase();
    const custom = vscode.workspace
      .getConfiguration('remoteRun')
      .get<Record<string, string>>('runCommands', {});
    const cmd = getRunCommand(ext, custom, host.remoteOs ?? 'linux');

    if (!cmd) {
      vscode.window.showWarningMessage(
        `No run command for "${ext}". Add one in Settings → Remote Run → Run Commands.`
      );
      return;
    }

    const remotePath = overrideRemotePath ?? remotePathFor(host, homeDir, localPath);
    const fullCmd = `${cmd} "${remotePath}"`;

    output.show(true);
    output.appendLine(`\n▶ ${fullCmd}  [${host.label}]`);
    output.appendLine('─'.repeat(60));

    return new Promise((resolve, reject) => {
      client.exec(fullCmd, (err, stream) => {
        if (err) { reject(err); return; }
        stream.on('data', (d: Buffer) => output.append(d.toString()));
        stream.stderr.on('data', (d: Buffer) => output.append(d.toString()));
        stream.on('close', (code: number) => {
          output.appendLine(`${'─'.repeat(60)}\n✓ exited ${code}\n`);
          resolve();
        });
        stream.on('error', reject);
      });
    });
  }
}

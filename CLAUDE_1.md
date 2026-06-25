# Remote Run — VS Code Extension

## Project Overview

A VS Code extension that lets you write code locally and run it on a remote machine (Raspberry Pi, Linux server, VM, etc.) seamlessly — without manually copying files or opening SSH terminals.

**Core workflow:**
1. Write code locally in VS Code
2. Press Save → file is automatically synced to the remote machine
3. Press Run → code executes on the remote machine
4. Output appears in the VS Code terminal/output panel locally

Built with TypeScript + Node.js (`ssh2` library).

---

## Goals

- Works with **any SSH host** (Raspberry Pi, Linux server, VM, etc.) — not Pi-specific
- Supports **any language** (Python, Node.js, Bash, etc.) — not a compiler, just sync + execute
- One-time setup per host: credentials stored **encrypted** via VS Code SecretStorage API (OS keychain)
- Auto-sync on save: local file → remote machine via SFTP
- One-click run: execute the current file on the remote and stream output back
- Graphical host management (no manual terminal SSH needed)

---

## Desired Features

### 1. Host Management
- Add / remove / edit SSH hosts (label, hostname, port, username, remote working directory)
- Hosts stored in VS Code settings (`settings.json`)
- Active host shown in VS Code status bar

### 2. Credential Storage (Encrypted)
- Password stored once via `context.secrets.store(key, value)` (VS Code SecretStorage)
- Uses OS keychain under the hood (Windows Credential Manager / macOS Keychain / libsecret on Linux)
- Key naming convention: `ssh-password-<hostId>`
- On first connect: prompt user for password → store it → never ask again
- Option to clear/reset stored credentials per host

### 3. Auto-Sync on Save
- Listen to `vscode.workspace.onDidSaveTextDocument`
- On save: upload the file via SFTP to the configured remote path
- Show status bar indicator: "Syncing..." → "✓ Synced" or "✗ Sync failed"
- Configurable: sync only when a host is active/connected

### 4. Remote Execution
- Command: "Remote Run: Run Current File"
- Determines run command based on file extension:
  - `.py` → `python3 filename.py`
  - `.js` → `node filename.js`
  - `.sh` → `bash filename.sh`
  - Configurable custom run commands per host or per file type
- Executes via SSH `exec` channel
- Streams stdout/stderr to a VS Code Output Channel or integrated terminal
- Shows exit code on completion

### 5. Status Bar Integration
- Shows active host name in status bar (bottom of VS Code)
- Click to switch host or disconnect
- Sync status indicator (idle / syncing / error)

### 6. Sidebar File Explorer (Secondary Feature)
- Optional Tree View showing remote directory structure
- Useful for browsing files on the remote without a terminal
- Uses `TreeDataProvider` registered as `remoteRunExplorer`

---

## Project Structure

```
remote-run/
├── src/
│   ├── extension.ts            ← Activation, command registration, event listeners
│   ├── sshManager.ts           ← SSH connection pool (ssh2 Client instances)
│   ├── credentialStore.ts      ← SecretStorage wrapper for passwords
│   ├── hostConfig.ts           ← Read/write host list from VS Code settings
│   ├── syncManager.ts          ← Auto-sync on save (SFTP upload)
│   ├── runManager.ts           ← Remote execution + output streaming
│   ├── statusBar.ts            ← Status bar item management
│   ├── treeView.ts             ← (Optional) Sidebar file explorer
│   └── utils.ts                ← Helpers (path joining, run command detection, etc.)
├── package.json                ← Extension manifest (commands, views, config)
├── tsconfig.json
├── CLAUDE.md                   ← This file
└── README.md
```

---

## Key VS Code APIs Used

| API | Purpose |
|---|---|
| `context.secrets` | Encrypted credential storage (SecretStorage) |
| `vscode.workspace.onDidSaveTextDocument` | Trigger sync on file save |
| `vscode.window.createOutputChannel` | Stream remote execution output |
| `vscode.window.createStatusBarItem` | Show active host + sync status |
| `vscode.window.showInputBox` | Prompt for hostname, username, password |
| `vscode.workspace.getConfiguration` | Read host list and settings |
| `vscode.window.registerTreeDataProvider` | (Optional) Sidebar file explorer |

---

## Dependencies

```json
{
  "dependencies": {
    "ssh2": "^1.x"
  },
  "devDependencies": {
    "@types/ssh2": "^1.x",
    "@types/vscode": "^1.x",
    "typescript": "^5.x"
  }
}
```

---

## package.json — Key Contributions

```json
"contributes": {
  "commands": [
    { "command": "remoteRun.addHost",        "title": "Remote Run: Add Host" },
    { "command": "remoteRun.connect",        "title": "Remote Run: Connect to Host" },
    { "command": "remoteRun.disconnect",     "title": "Remote Run: Disconnect" },
    { "command": "remoteRun.runFile",        "title": "Remote Run: Run Current File" },
    { "command": "remoteRun.syncFile",       "title": "Remote Run: Sync Current File" },
    { "command": "remoteRun.clearPassword",  "title": "Remote Run: Clear Saved Password" }
  ],
  "configuration": {
    "title": "Remote Run",
    "properties": {
      "remoteRun.hosts": {
        "type": "array",
        "default": [],
        "description": "List of SSH hosts",
        "items": {
          "type": "object",
          "properties": {
            "id":           { "type": "string" },
            "label":        { "type": "string" },
            "host":         { "type": "string" },
            "port":         { "type": "number", "default": 22 },
            "username":     { "type": "string" },
            "remotePath":   { "type": "string", "default": "~" }
          }
        }
      },
      "remoteRun.syncOnSave": {
        "type": "boolean",
        "default": true,
        "description": "Automatically sync files to remote on save"
      },
      "remoteRun.runCommands": {
        "type": "object",
        "default": {
          ".py": "python3",
          ".js": "node",
          ".sh": "bash"
        },
        "description": "Run command per file extension"
      }
    }
  }
}
```

---

## Credential Storage — Implementation Pattern

```typescript
// credentialStore.ts
import * as vscode from 'vscode';

export class CredentialStore {
  constructor(private secrets: vscode.SecretStorage) {}

  private key(hostId: string) {
    return `ssh-password-${hostId}`;
  }

  async getPassword(hostId: string): Promise<string | undefined> {
    return this.secrets.get(this.key(hostId));
  }

  async setPassword(hostId: string, password: string): Promise<void> {
    await this.secrets.store(this.key(hostId), password);
  }

  async clearPassword(hostId: string): Promise<void> {
    await this.secrets.delete(this.key(hostId));
  }
}
```

---

## SSH Connection — Implementation Pattern

```typescript
// sshManager.ts
import { Client } from 'ssh2';

export async function connectToHost(host: HostConfig, password: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => resolve(conn))
        .on('error', reject)
        .connect({
          host: host.host,
          port: host.port ?? 22,
          username: host.username,
          password,
        });
  });
}
```

## Sync on Save — Implementation Pattern

```typescript
// extension.ts
vscode.workspace.onDidSaveTextDocument(async (doc) => {
  if (!activeHost) return;
  statusBar.setText('$(sync~spin) Syncing...');
  try {
    await syncManager.uploadFile(doc.fileName, activeHost);
    statusBar.setText('$(check) Synced');
  } catch (e) {
    statusBar.setText('$(error) Sync failed');
  }
});
```

## Remote Execution — Implementation Pattern

```typescript
// runManager.ts
export async function runFile(conn: Client, remotePath: string, ext: string, output: vscode.OutputChannel) {
  const cmd = getRunCommand(ext); // e.g. "python3"
  conn.exec(`${cmd} ${remotePath}`, (err, stream) => {
    stream.on('data', (data: Buffer) => output.append(data.toString()));
    stream.stderr.on('data', (data: Buffer) => output.append(data.toString()));
    stream.on('close', (code: number) => output.appendLine(`\nProcess exited with code ${code}`));
  });
}
```

---

## Development Notes

- **Test with F5** in VS Code → opens Extension Development Host
- **SecretStorage** requires a proper `publisher` field in `package.json`
- SFTP upload: use `conn.sftp((err, sftp) => sftp.fastPut(localPath, remotePath, cb))`
- Status bar priority: use a high number (e.g. `100`) to appear on the left side
- Output channel: create once with `vscode.window.createOutputChannel('Remote Run')` and reuse

---

## Developer

Efthymis Tsoumetis — CS & Engineering student, University of Ioannina, Greece.
Also working on: Univres (Flutter app), GreekPremierKIDS (mobile curriculum platform).
Raspberry Pi Zero 2W available for testing (hostname: `rpi5`, username: `raspberry`, port: 22).

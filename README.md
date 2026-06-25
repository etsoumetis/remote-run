# Remote Run

Write code locally, run it on a remote machine — without copying files or opening SSH terminals manually.

**Workflow:** Edit → Save → output appears in a terminal connected to your remote device.

---

## Features

### Sidebar host manager
Add and manage SSH hosts from a dedicated sidebar panel. Connected hosts show with a green indicator; disconnected with grey.

### Auto-sync on Save
Whenever you save a file (Ctrl+S), it is automatically uploaded to the remote machine via SFTP. The status bar shows `Synced → filename` for confirmation.

### Run on Remote
Click the **Run on Remote** button (▶) in the editor toolbar to sync and run the active file on the remote device. Output appears in an integrated SSH terminal — exactly like running locally.

### Remote file browser
Browse the remote file system in the sidebar tree view. Click a file to open and edit it directly (no temp files). Changes are saved back to the remote on Ctrl+S.

### Remote operations
Right-click any file or folder in the tree to:
- New File / New Folder
- Rename
- Delete

### Integrated SSH terminal
Open a full interactive SSH terminal for any connected host from the sidebar.

### OS support
Linux (Raspberry Pi, Ubuntu, Debian), macOS, and Windows remote machines.

---

## Getting Started

1. Click the **Remote Run** icon in the Activity Bar (left sidebar).
2. Click **+** to add a host — enter label, hostname/IP, port, username, OS, and optionally a working directory.
3. Click the plug icon next to a host to connect. Enter your password (saved securely in the OS keychain).
4. Open a local file and press **Ctrl+S** — it syncs automatically.
5. Press the **▶** button in the editor toolbar to run on the remote.

---

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `remoteRun.syncOnSave` | `true` | Auto-upload the current file on save when connected |
| `remoteRun.runCommands` | `{}` | Custom run commands by extension, e.g. `{ ".py": "python3" }` |

---

## Requirements

- The remote machine must have SSH (OpenSSH) running and accessible over the network.
- For running files, the relevant interpreter (Python, Node.js, etc.) must be installed on the remote machine.

---

## Supported Languages (default run commands)

| Extension | Linux/macOS | Windows |
|---|---|---|
| `.py` | `python3` | `python` |
| `.js` | `node` | `node` |
| `.sh` | `bash` | — |
| `.ts` | `ts-node` | `ts-node` |
| `.rb` | `ruby` | `ruby` |
| `.go` | `go run` | `go run` |
| `.java` | `java` | `java` |
| `.php` | `php` | `php` |

Add more via `remoteRun.runCommands` in Settings.

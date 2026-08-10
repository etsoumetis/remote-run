# Remote Run

**Write code on your machine. Run it on the other one.**

Remote Run turns any SSH-reachable computer — a Raspberry Pi on your desk, a server in a rack, a VM in the cloud — into a target you can edit, run, browse and preview from inside VS Code. No manual `scp`, no second terminal window, no mounting drives.

The whole point is that it stays out of the way. It was built against a Raspberry Pi Zero 2 W with 512 MB of RAM, and every feature is designed so that neither the extension nor the device it talks to has to hold a large file in memory to do its job.

```
Edit locally  →  Ctrl+S  →  runs on the remote  →  output in your terminal
```

---

## Features

### Run on remote

Press **▶** in the editor toolbar. The file syncs, executes on the remote, and its output streams back into an integrated terminal — colours, prompts, interactive input and all. Press **■** to stop it. Scripts that need hardware access (GPIO, I²C, cameras) can be set to run under `sudo` automatically, using the password already in your keychain.

### Auto-sync on save

Every **Ctrl+S** uploads the file over SFTP. The status bar confirms with `Synced → filename`. The SSH session is pooled and reused, so a save costs one round trip rather than a fresh handshake.

### Work with several machines at once

Connect to as many hosts as you like and keep them all live. One is marked **active** (⭐) — that's where **Run** and sync-on-save go. Switch from the status bar or the host's context menu.

Each host runs independently: a script on the Pi keeps going while you start another on a VM, and disconnecting one leaves the rest untouched. A remote file always runs on the host it lives on, whichever host happens to be active.

### Move anything, in any direction

Any file type — images, video, archives, binaries, entire folder trees.

| From | To | How |
|---|---|---|
| Your computer | A host | Drag files onto a host or folder · **Upload Files / Folder…** · right-click in the VS Code explorer → **Send to Remote Host…** |
| A host | Another host | **Copy** → **Paste Here** · **Send to Host…** · drag between hosts in the tree |
| A host | The same host | The same actions — executed as a remote `cp`, so no bytes cross the network |
| A host | Your computer | **Download to This Computer…** |

Everything streams. Host-to-host transfers are piped from one SSH connection straight into the other and never touch your disk; uploads and downloads move one 64 KB buffer at a time. **A 4 GB video costs the same memory as a 4 KB script.**

Transfers report progress and can be cancelled mid-flight. Permissions and timestamps are preserved, empty directories survive, and symlinks are skipped rather than silently expanded into copies.

### Preview media inside VS Code

Click a `.png`, `.mp4`, `.mp3` or `.pdf` in the remote tree and it opens in an editor tab. No download step, no external player, no leaving the window.

**Video, audio and large PDFs are streamed and never stored.** A loopback connection translates the player's byte-range requests into SFTP ranged reads, so the remote sends only the parts you actually play — and nothing lands on your disk. Seeking into a two-hour film on a Pi Zero costs a couple of hundred kilobytes, not the whole file. Large PDFs work the same way: pdf.js pulls individual pages, so a 200 MB document opens on page one immediately.

Images and small PDFs can't be rendered in pieces, so those alone use a temporary cache. It is wiped when VS Code closes *and* again the next time it starts, so a crash can't leave anything behind, and `remoteRun.preview.maxCacheSizeMB` caps it in between.

If a stream can't be played, the preview quietly retries from a downloaded copy before reporting anything, then offers **Open with Default App** or **Save a copy…**.

### Remote file browser

Browse the remote filesystem in the sidebar. Click a file to edit it in place — no temp copies, no sync step; **Ctrl+S** writes straight back over SFTP. Files too large to hold in an editor buffer are refused with a clear message instead of freezing the window.

Right-click any item for:

- New File · New Folder · Upload Files… · Upload Folder…
- Preview · Open as Text · Open with Default App
- Copy · Paste Here · Send to Host… · Download to This Computer…
- Rename · Delete

### Integrated SSH terminal

Open a full interactive shell on any connected host, straight from the sidebar. It shares the existing connection, so there's no second login.

### Credentials

Passwords are stored in the OS keychain through VS Code's SecretStorage — never in settings, never in plain text. `Remote Run: Clear Saved Password` removes one at any time.

---

## Getting started

1. Click the **Remote Run** icon in the Activity Bar.
2. Click **+** and enter a label, hostname or IP, port, username, the remote OS, and optionally a working directory.
3. Click the plug icon to connect and enter your password — it's saved to the keychain.
4. Open a file and press **Ctrl+S** to sync it.
5. Press **▶** to run it on the remote.

---

## Requirements

- An SSH server (OpenSSH) reachable on the remote machine.
- The relevant interpreter installed remotely for whatever you intend to run.
- Desktop VS Code. Media streaming uses a loopback connection and is not available in the browser build.

Remote machines may run **Linux** (Raspberry Pi OS, Ubuntu, Debian…), **macOS**, or **Windows** with OpenSSH Server.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `remoteRun.syncOnSave` | `true` | Upload the current file on save when connected |
| `remoteRun.runCommands` | `{}` | Custom run commands by extension, e.g. `{ ".py": "python3" }` |
| `remoteRun.maxEditableFileSizeMB` | `16` | Largest remote file that may be opened in the text editor |
| `remoteRun.preview.streaming` | `true` | Stream video, audio and large PDFs instead of downloading them first |
| `remoteRun.preview.pdfStreamThresholdMB` | `4` | PDFs above this size stream page-by-page |
| `remoteRun.preview.maxDownloadMB` | `64` | Confirm before downloading a preview larger than this |
| `remoteRun.preview.maxCacheSizeMB` | `256` | Disk budget for cached previews; least-recently-used are dropped |
| `remoteRun.preview.clearCacheOnExit` | `true` | Delete cached previews when VS Code closes |

---

## Run commands

| Extension | Linux / macOS | Windows |
|---|---|---|
| `.py` | `python3` | `python` |
| `.js` | `node` | `node` |
| `.ts` | `ts-node` | `ts-node` |
| `.sh` | `bash` | — |
| `.ps1` | — | `powershell -ExecutionPolicy Bypass -File` |
| `.rb` | `ruby` | `ruby` |
| `.go` | `go run` | `go run` |
| `.java` | `java` | `java` |
| `.php` | `php` | `php` |
| `.pl` | `perl` | — |
| `.r` | `Rscript` | — |

Override or extend any of these with `remoteRun.runCommands`.

---

## Previewable formats

| Type | Formats | How it loads |
|---|---|---|
| Image | png · jpg · gif · webp · bmp · avif · ico · svg | Temporary cache |
| Video | mp4 · m4v · webm · mov · mkv · ogv | Streamed on demand |
| Audio | mp3 · wav · ogg · flac · m4a · aac · opus · wma · aiff · amr | Streamed on demand |
| PDF | pdf | Streamed above 4 MB, otherwise cached |

Playback uses the codecs built into VS Code. For a format it can't decode — HEVC in an `.mkv`, say — the preview offers **Save a copy…** or **Open with Default App**.

Text and source files open in the editor as normal. For anything else (`.docx`, `.zip`, `.stl`), **Open with Default App** fetches the file and hands it to your operating system.

---

## How it stays fast

A few decisions do most of the work, and they're worth knowing about if you're running this against something small:

- **Connections are pooled.** One SSH session per host, with the SFTP channel kept open and reused.
- **Bulk work runs on its own channel.** Previews and transfers use a second SFTP channel, so a long video stream can never make Ctrl+S feel stuck behind it.
- **Nothing is read whole.** Every transfer path is a stream with backpressure. Peak memory is one buffer, not one file.
- **Nothing is fetched speculatively.** Video sends `preload="metadata"`; PDFs fetch page geometry for one page and resolve the rest as you scroll; aborted requests tear their remote reads down immediately, so scrubbing a video doesn't pile up reads on the device.

---

## License

CC BY-NC-SA 4.0 — see [LICENSE](LICENSE).

Bundles [pdf.js](https://mozilla.github.io/pdf.js/) (Apache 2.0) for PDF rendering.

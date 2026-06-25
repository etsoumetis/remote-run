import * as path from 'path';
import type { RemoteOs } from './hostConfig';

const LINUX_COMMANDS: Record<string, string> = {
  '.py':   'python3',
  '.js':   'node',
  '.sh':   'bash',
  '.ts':   'ts-node',
  '.rb':   'ruby',
  '.pl':   'perl',
  '.php':  'php',
  '.go':   'go run',
  '.r':    'Rscript',
  '.R':    'Rscript',
  '.java': 'java',
};

const WINDOWS_COMMANDS: Record<string, string> = {
  '.py':   'python',
  '.js':   'node',
  '.ps1':  'powershell -ExecutionPolicy Bypass -File',
  '.bat':  'cmd /c',
  '.ts':   'ts-node',
  '.rb':   'ruby',
  '.php':  'php',
  '.go':   'go run',
  '.java': 'java',
};

export function getRunCommand(ext: string, custom: Record<string, string>, remoteOs: RemoteOs = 'linux'): string | undefined {
  const defaults = remoteOs === 'windows' ? WINDOWS_COMMANDS : LINUX_COMMANDS;
  return custom[ext] ?? defaults[ext];
}

export function posixJoin(...parts: string[]): string {
  return parts
    .map(p => p.replace(/\\/g, '/'))
    .join('/')
    .replace(/\/+/g, '/');
}

export function expandHome(remotePath: string, homeDir: string, remoteOs: RemoteOs = 'linux'): string {
  const effective = remotePath.trim() || '~';

  if (remoteOs === 'windows') {
    if (effective === '~') {
      return winToSftp(homeDir);
    }
    if (effective.startsWith('~/')) {
      return winToSftp(homeDir) + '/' + effective.slice(2);
    }
    // If the user wrote a Windows path like C:\Users\..., convert it
    if (/^[A-Za-z]:[/\\]/.test(effective)) {
      return winToSftp(effective);
    }
    return effective; // already in SFTP format (/C:/...)
  }

  if (effective === '~' || effective.startsWith('~/')) {
    return homeDir + effective.slice(1);
  }
  return effective;
}

// C:\Users\foo  →  /C:/Users/foo  (OpenSSH for Windows SFTP format)
function winToSftp(winPath: string): string {
  return '/' + winPath.replace(/\\/g, '/').replace(/^\/+/, '');
}

export function homeDirCommand(remoteOs: RemoteOs): string {
  return remoteOs === 'windows' ? 'echo %USERPROFILE%' : 'echo $HOME';
}

export function remotePathFor(
  host: { remotePath: string; remoteOs: RemoteOs },
  homeDir: string,
  localFile: string,
): string {
  const base = expandHome(host.remotePath, homeDir, host.remoteOs);
  const filename = path.basename(localFile);
  return posixJoin(base, filename);
}

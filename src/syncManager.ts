import type { SFTPWrapper } from 'ssh2';
import type { HostConfig } from './hostConfig';
import { remotePathFor } from './utils';

export class SyncManager {
  uploadFile(localPath: string, host: HostConfig, homeDir: string, sftp: SFTPWrapper): Promise<void> {
    const remotePath = remotePathFor(host, homeDir, localPath);
    return new Promise((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, err => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

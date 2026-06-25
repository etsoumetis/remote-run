import type { SFTPWrapper } from 'ssh2';
import type { HostConfig } from './hostConfig';
import { remotePathFor } from './utils';

export class SyncManager {
  uploadFile(localPath: string, host: HostConfig, homeDir: string, sftp: SFTPWrapper): Promise<string> {
    return this.upload(localPath, remotePathFor(host, homeDir, localPath), sftp);
  }

  upload(localPath: string, remotePath: string, sftp: SFTPWrapper): Promise<string> {
    return new Promise((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, err => {
        if (err) reject(err);
        else resolve(remotePath);
      });
    });
  }
}

import * as vscode from 'vscode';

export class CredentialStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private key(hostId: string): string {
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

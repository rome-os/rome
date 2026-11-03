import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import type { SecureKeyValueStore } from "@rome-os/libs/native-auth";

/** The slice of Electron's `safeStorage` this store needs. */
export interface StringCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export function resolveCredentialFile(home = homedir()): string {
  return join(home, ".rome-desktop", "cloud-credentials.bin");
}

/**
 * Keeps the Rome Cloud credential and instance sessions in one file encrypted
 * with the OS keychain (Electron `safeStorage`). The file never holds a token
 * in plain text, and it refuses to write when the keychain is unavailable
 * rather than falling back to plain text.
 */
export class EncryptedFileStore implements SecureKeyValueStore {
  constructor(
    private readonly cipher: StringCipher,
    private readonly file = resolveCredentialFile(),
  ) {}

  private readAll(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    try {
      const value: unknown = JSON.parse(this.cipher.decryptString(readFileSync(this.file)));
      if (typeof value !== "object" || value === null) return {};
      return Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, string] => {
          return typeof entry[1] === "string";
        }),
      );
    } catch {
      // A file the keychain can no longer open is as good as signed out.
      return {};
    }
  }

  private writeAll(values: Record<string, string>): void {
    if (Object.keys(values).length === 0) {
      rmSync(this.file, { force: true });
      return;
    }
    if (!this.cipher.isEncryptionAvailable()) {
      throw new Error("The system keychain is not available, so Rome cannot store the sign-in.");
    }
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, this.cipher.encryptString(JSON.stringify(values)), { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  async getItem(key: string): Promise<string | null> {
    return this.readAll()[key] ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.writeAll({ ...this.readAll(), [key]: value });
  }

  async deleteItem(key: string): Promise<void> {
    const values = this.readAll();
    delete values[key];
    this.writeAll(values);
  }
}

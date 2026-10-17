import { mkdtempSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "@rstest/core";
import { EncryptedFileStore, type StringCipher } from "./credential-store";

// Reverses the bytes, which is enough to prove nothing lands in plain text.
function fakeCipher(available = true): StringCipher {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from(text, "utf8").reverse(),
    decryptString: (data) => Buffer.from(data).reverse().toString("utf8"),
  };
}

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "rome-cred-")), "nested", "cloud-credentials.bin");
}

describe("EncryptedFileStore", () => {
  it("round-trips values through an owner-only encrypted file", async () => {
    const file = tempFile();
    const store = new EncryptedFileStore(fakeCipher(), file);
    await store.setItem("vault", "romemob_secret");
    expect(await store.getItem("vault")).toBe("romemob_secret");
    expect(readFileSync(file).toString("utf8")).not.toContain("romemob_secret");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await store.deleteItem("vault");
    expect(await store.getItem("vault")).toBeNull();
  });

  it("refuses to write when the keychain is unavailable", async () => {
    const store = new EncryptedFileStore(fakeCipher(false), tempFile());
    await expect(store.setItem("vault", "secret")).rejects.toThrow(/keychain/);
  });

  it("treats a file the keychain cannot open as empty", async () => {
    const file = tempFile();
    await new EncryptedFileStore(fakeCipher(), file).setItem("vault", "secret");
    const broken: StringCipher = {
      ...fakeCipher(),
      decryptString: () => {
        throw new Error("keychain item changed");
      },
    };
    expect(await new EncryptedFileStore(broken, file).getItem("vault")).toBeNull();
  });
});

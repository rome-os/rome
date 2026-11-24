import { describe, expect, it } from "@rstest/core";
import {
  computerUseApprovalKey,
  grantComputerUseApproval,
  isComputerUseApprovalSetting,
  readComputerUseApproval,
} from "./computer-use-approvals.js";

function memorySettings() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async <T = unknown>(key: string): Promise<T | null> =>
      store.has(key) ? (store.get(key) as T) : null,
    set: async (key: string, value: unknown): Promise<void> => {
      store.set(key, value);
    },
  };
}

describe("computer-use-approvals", () => {
  it("builds scoped approval keys and recognizes the approval prefix", () => {
    const withAccount = computerUseApprovalKey(
      { userId: "guardian-1", accountId: "acct-1" },
      "device-mac",
      "mac",
    );
    const withoutAccount = computerUseApprovalKey({ userId: "guardian-1" }, "local-host", "local");

    expect(isComputerUseApprovalSetting(withAccount)).toBe(true);
    expect(isComputerUseApprovalSetting(withoutAccount)).toBe(true);
    expect(isComputerUseApprovalSetting("computerUse.other")).toBe(false);
    expect(withAccount).not.toBe(withoutAccount);
  });

  it("grants idempotently and verifies HMAC-bound approval tokens", async () => {
    const settings = memorySettings();
    const key = computerUseApprovalKey({ userId: "guardian-1" }, "device-1", "mac");

    expect(await readComputerUseApproval(settings, key)).toBeUndefined();

    await grantComputerUseApproval(settings, key);
    const firstId = await readComputerUseApproval(settings, key);
    expect(firstId).toMatch(/^[0-9a-f-]{36}$/);

    // Re-granting keeps the existing approval ID rather than rotating it.
    await grantComputerUseApproval(settings, key);
    expect(await readComputerUseApproval(settings, key)).toBe(firstId);
  });

  it("rejects malformed, tampered, or cross-key copied tokens", async () => {
    const settings = memorySettings();
    const keyA = computerUseApprovalKey({ userId: "guardian-1" }, "device-a", "mac");
    const keyB = computerUseApprovalKey({ userId: "guardian-1" }, "device-b", "mac");

    await grantComputerUseApproval(settings, keyA);
    const validToken = String(settings.store.get(keyA));

    // Copying a valid token to another device/user key must fail HMAC verification.
    await settings.set(keyB, validToken);
    expect(await readComputerUseApproval(settings, keyB)).toBeUndefined();

    // Flipping a nibble in the proof must fail verification.
    const flippedLast = validToken.endsWith("0") ? "1" : "0";
    await settings.set(keyA, validToken.slice(0, -1) + flippedLast);
    expect(await readComputerUseApproval(settings, keyA)).toBeUndefined();

    // Malformed values fail closed.
    await settings.set(keyA, "not-a-valid-token");
    expect(await readComputerUseApproval(settings, keyA)).toBeUndefined();
  });
});

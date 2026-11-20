import { describe, expect, it } from "@rstest/core";
import { ownAccountNames } from "./own-account-name.js";

function registry(profile: Record<string, unknown> | null) {
  return {
    all: () => [{ id: "conn-1", connectionKind: "discord" }],
    grantOf: async () => (profile ? { profile } : null),
    getDescriptor: () => ({
      reviveProfile: (record: Record<string, unknown>) => ({
        displayName: record.displayName as string | undefined,
        handle: record.handle as string | undefined,
        email: undefined,
        avatarUrl: undefined,
      }),
    }),
  } as unknown as Parameters<typeof ownAccountNames>[0];
}

describe("ownAccountNames", () => {
  it("names the account by its handle, else its display name", async () => {
    expect(await ownAccountNames(registry({ handle: "Rome" }))("conn-1")).toBe("Rome");
    expect(await ownAccountNames(registry({ displayName: "Scout" }))("conn-1")).toBe("Scout");
  });

  it("answers null for an unknown connection or a profile that names nothing", async () => {
    expect(await ownAccountNames(registry({ handle: "Rome" }))("conn-2")).toBeNull();
    expect(await ownAccountNames(registry(null))("conn-1")).toBeNull();
    expect(await ownAccountNames(registry({}))("conn-1")).toBeNull();
  });
});

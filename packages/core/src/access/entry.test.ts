import { describe, expect, it } from "@rstest/core";
import { DashboardAccessState } from "./dashboard-access-state.js";
import { mayEnter } from "./entry.js";

const member = { kind: "visitor", accountId: "ada", email: "ada@example.com" } as const;
const guest = { kind: "visitor", accountId: "guest", email: "guest@example.com" } as const;
const guardian = { kind: "guardian", userId: "owner", via: "cookie" } as const;

describe("mayEnter", () => {
  it("lets in the guardian and whoever the allow-list names, and no one else", async () => {
    const allowList = new DashboardAccessState();
    allowList.setCloudEmailAccess(["ada@example.com"]);
    expect(await mayEnter(guardian, allowList)).toEqual(guardian);
    expect(await mayEnter({ ...guardian, via: "loopback" }, allowList)).toEqual({
      ...guardian,
      via: "loopback",
    });
    expect(await mayEnter(member, allowList)).toEqual(member);
    expect(await mayEnter(guest, allowList)).toBeNull();
    expect(await mayEnter({ kind: "anonymous" }, allowList)).toBeNull();
    expect(await mayEnter(undefined, allowList)).toBeNull();
  });
});

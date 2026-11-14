import { describe, expect, it } from "@rstest/core";
import type { ConciergeConnectorsResponse } from "@rome/api-types/concierge";
import { conciergeConnectorsQuery, followStateWith } from "./use-concierge-connectors";

const list = (
  follows: { target: string; state: "active" | "off" | "unavailable" }[],
  watch: Record<string, unknown> = { state: "unlocked" },
): ConciergeConnectorsResponse =>
  ({
    connectors: [
      { service: "github", label: "GitHub", capabilities: { watch: { ...watch, follows } } },
    ],
    rules: {},
  }) as unknown as ConciergeConnectorsResponse;

describe("followStateWith", () => {
  const row = { source: "github", target: "acme/widgets", state: "active" as const };

  it("keeps the task list's state until the connector list is read", () => {
    expect(followStateWith(undefined, row)).toBe("active");
  });

  it("dims a follow its service does not deliver now", () => {
    expect(followStateWith(list([{ target: "acme/widgets", state: "unavailable" }]), row)).toBe(
      "unavailable",
    );
    expect(followStateWith(list([], { state: "needs-auth", missingGrants: [] }), row)).toBe(
      "unavailable",
    );
    expect(
      followStateWith(list([], { state: "unlocked", degradation: { reason: "no relay" } }), row),
    ).toBe("unavailable");
    expect(followStateWith(list([{ target: "acme/widgets", state: "active" }]), row)).toBe(
      "active",
    );
  });

  it("takes on or off from the task list, never from an older snapshot", () => {
    // A follow made, or turned on, since the snapshot was read.
    expect(followStateWith(list([]), row)).toBe("active");
    expect(followStateWith(list([{ target: "acme/widgets", state: "off" }]), row)).toBe("active");
    expect(
      followStateWith(list([{ target: "acme/widgets", state: "active" }]), {
        ...row,
        state: "off",
      }),
    ).toBe("off");
    // A service the snapshot does not list yet.
    expect(followStateWith(list([]), { ...row, source: "gmail" })).toBe("active");
  });

  it("keeps a follow the task list already says is unavailable", () => {
    expect(followStateWith(list([]), { ...row, state: "unavailable" })).toBe("unavailable");
  });
});

describe("the connector list query", () => {
  it("stays fresh for a minute and is not read again when the tab comes back", () => {
    expect(conciergeConnectorsQuery.staleTime).toBe(60_000);
    expect(conciergeConnectorsQuery.refetchOnWindowFocus).toBe(false);
  });
});

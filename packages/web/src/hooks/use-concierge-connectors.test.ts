import { describe, expect, it } from "@rstest/core";
import type { ConciergeConnectorsResponse } from "@rome/api-types/concierge";
import { conciergeConnectorsQuery, followStateWith } from "./use-concierge-connectors";

const list = (
  follows: { target: string; state: "active" | "off" | "unavailable" }[],
): ConciergeConnectorsResponse =>
  ({
    connectors: [{ service: "github", label: "GitHub", capabilities: { watch: { follows } } }],
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
    expect(followStateWith(list([{ target: "acme/widgets", state: "active" }]), row)).toBe(
      "active",
    );
  });

  it("reads a follow the list does not show, or a service it does not have, as unavailable", () => {
    expect(followStateWith(list([]), row)).toBe("unavailable");
    expect(followStateWith(list([]), { ...row, source: "gmail" })).toBe("unavailable");
  });

  it("keeps an off follow off whatever its service says", () => {
    expect(followStateWith(list([]), { ...row, state: "off" })).toBe("off");
  });
});

describe("the connector list query", () => {
  it("stays fresh for a minute and is not read again when the tab comes back", () => {
    expect(conciergeConnectorsQuery.staleTime).toBe(60_000);
    expect(conciergeConnectorsQuery.refetchOnWindowFocus).toBe(false);
  });
});

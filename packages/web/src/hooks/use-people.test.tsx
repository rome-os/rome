// @rstest-environment jsdom
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { PeopleList } from "@rome/api-types/people";
import { usePeople } from "./use-people";

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function peopleList(): PeopleList {
  return {
    people: [
      {
        id: "mock-guardian",
        displayName: "Mock Guardian",
        bondLevel: "guardian",
        accounts: [],
        messageCount: 0,
        latest: null,
      },
      {
        id: "ray-oster",
        displayName: "Ray Oster",
        bondLevel: "inner-circle",
        accounts: [{ channel: "telegram", channelUserId: "418820113", displayName: "ray" }],
        messageCount: 4,
        latest: null,
      },
    ],
    counts: { all: 2, guardian: 1, "inner-circle": 1, acquaintance: 0, other: 0 },
  };
}

describe("usePeople", () => {
  it("reads the curated people from GET /api/people", async () => {
    const fetchSpy = rs
      .spyOn(globalThis, "fetch")
      .mockImplementation((async () => Response.json(peopleList())) as typeof fetch);

    const { result } = renderHook(() => usePeople(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(fetchSpy.mock.calls.map(([input]) => String(input))).toEqual(["/api/people"]);
  });

  it("unwraps the listing envelope into its rows, whole", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation((async () =>
      Response.json(peopleList())) as typeof fetch);

    const { result } = renderHook(() => usePeople(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toEqual(peopleList().people);
  });

  it("answers an empty listing when the read fails, so the composer still mounts", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation((async () =>
      Response.json({ error: "nope" }, { status: 500 })) as typeof fetch);

    const { result } = renderHook(() => usePeople(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data).toEqual([]));
  });
});

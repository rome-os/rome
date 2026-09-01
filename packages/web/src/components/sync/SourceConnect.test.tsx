// @rstest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { RemoteTargetCandidate } from "@/lib/sync-api";
import { SourceConnect } from "./SourceConnect";

const targets: RemoteTargetCandidate[] = [
  {
    sourceId: "git",
    locator: { fullName: "amantru/rome-internal" },
    label: "amantru/rome-internal",
    group: "amantru",
  },
  {
    sourceId: "git",
    locator: { fullName: "amantru/other-project" },
    label: "amantru/other-project",
    group: "amantru",
  },
];

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function mockSyncApi() {
  return rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url === "/api/sync/sources") {
      return Response.json({
        sources: [{ id: "git", label: "GitHub", available: true }],
      });
    }
    if (url.startsWith("/api/sync/groups")) {
      return Response.json({ groups: [{ id: "amantru", label: "amantru" }] });
    }
    if (url === "/api/sync/targets" && init?.method === "POST") {
      const request = JSON.parse(String(init.body));
      return Response.json({
        target: {
          sourceId: request.source,
          locator: { fullName: `${request.group}/${request.name}` },
          label: `${request.group}/${request.name}`,
        },
      });
    }
    if (url.startsWith("/api/sync/targets")) {
      return Response.json({ targets });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch);
}

describe("SourceConnect repository picker", () => {
  it("filters and selects an existing repository from the keyboard", async () => {
    mockSyncApi();
    const onResolved = rs.fn();
    const user = userEvent.setup();
    render(<SourceConnect mode="select" open onClose={rs.fn()} onResolved={onResolved} />);

    const input = await screen.findByRole("combobox", { name: "Repository" });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));

    await user.type(input, "other-project");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option").textContent).toContain("amantru/other-project");

    await user.keyboard("{ArrowDown}{Enter}");
    expect(onResolved).toHaveBeenCalledWith(targets[1], "auto");
  });

  it("creates a free-text repository from the keyboard", async () => {
    const fetchSpy = mockSyncApi();
    const onResolved = rs.fn();
    const user = userEvent.setup();
    render(<SourceConnect mode="select" open onClose={rs.fn()} onResolved={onResolved} />);

    const input = await screen.findByRole("combobox", { name: "Repository" });
    await user.type(input, "new-project");
    expect(screen.getByRole("option").textContent).toContain("Create amantru/new-project");

    await user.keyboard("{ArrowDown}{Enter}");

    await waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith(
        {
          sourceId: "git",
          locator: { fullName: "amantru/new-project" },
          label: "amantru/new-project",
        },
        "auto",
      ),
    );
    const createCall = fetchSpy.mock.calls.find(
      ([input, init]) => String(input) === "/api/sync/targets" && init?.method === "POST",
    );
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      source: "git",
      group: "amantru",
      name: "new-project",
      private: true,
    });
  });
});

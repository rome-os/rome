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
    if (url === "/api/sync/link") {
      return Response.json({ state: "clean" });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch);
}

function linkRequestBody(fetchSpy: ReturnType<typeof mockSyncApi>): unknown {
  const linkCall = fetchSpy.mock.calls.find(([input]) => String(input) === "/api/sync/link");
  return JSON.parse(String(linkCall?.[1]?.body));
}

describe("SourceConnect repository picker", () => {
  it("filters and selects an existing repository from the keyboard", async () => {
    const fetchSpy = mockSyncApi();
    const onLinked = rs.fn();
    const user = userEvent.setup();
    render(
      <SourceConnect projectPath="/projects/demo" open onClose={rs.fn()} onLinked={onLinked} />,
    );

    const input = await screen.findByRole("combobox", { name: "Repository" });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));

    await user.type(input, "other-project");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option").textContent).toContain("amantru/other-project");

    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith({ state: "clean" }));
    expect(linkRequestBody(fetchSpy)).toEqual({
      projectPath: "/projects/demo",
      source: "git",
      target: targets[1],
      strategy: "auto",
    });
  });

  it("creates a free-text repository from the keyboard", async () => {
    const fetchSpy = mockSyncApi();
    const onLinked = rs.fn();
    const user = userEvent.setup();
    render(
      <SourceConnect projectPath="/projects/demo" open onClose={rs.fn()} onLinked={onLinked} />,
    );

    const input = await screen.findByRole("combobox", { name: "Repository" });
    await user.type(input, "new-project");
    expect(screen.getByRole("option").textContent).toContain("Create amantru/new-project");

    await user.keyboard("{ArrowDown}{Enter}");

    await waitFor(() => expect(onLinked).toHaveBeenCalledWith({ state: "clean" }));
    expect(linkRequestBody(fetchSpy)).toEqual({
      projectPath: "/projects/demo",
      source: "git",
      target: {
        sourceId: "git",
        locator: { fullName: "amantru/new-project" },
        label: "amantru/new-project",
      },
      strategy: "auto",
    });
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

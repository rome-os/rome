// @rstest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { SyncStatus } from "@/lib/sync-api";
import { SyncStatusPanel } from "./SyncStatusPanel";

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function mockStatus(status: SyncStatus) {
  return rs.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(status));
}

describe("SyncStatusPanel", () => {
  it("links the remote label to the repository when a URL is available", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/sync/status")) {
        return Response.json({
          state: "linked",
          sourceId: "git",
          remoteLabel: "amantru/rome-internal",
          remoteUrl: "https://github.com/amantru/rome-internal",
          private: true,
          ref: "main",
        });
      }
      return Response.json({}, { status: 404 });
    }) as typeof fetch);

    render(<SyncStatusPanel path="@memory" />);

    const repoLink = await screen.findByRole("link", { name: "amantru/rome-internal" });
    expect(repoLink.getAttribute("href")).toBe("https://github.com/amantru/rome-internal");
    expect(repoLink.getAttribute("target")).toBe("_blank");
    expect(screen.queryByText("github.com/amantru/rome-internal")).toBeNull();
  });
});

describe("SyncStatusPanel branch reset", () => {
  it("replaces refresh with reset on a clean non-main branch", async () => {
    mockStatus({
      state: "linked",
      ref: "feature/project-update",
      defaultRef: "main",
      changes: { added: 0, modified: 0, removed: 0 },
    });

    render(<SyncStatusPanel path="apps" />);

    expect(await screen.findByRole("button", { name: "Reset to main branch" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  });

  it("hides reset when the feature branch has local changes", async () => {
    mockStatus({
      state: "ahead",
      ref: "feature/project-update",
      defaultRef: "main",
      changes: { added: 0, modified: 1, removed: 0 },
    });

    render(<SyncStatusPanel path="apps" />);

    expect(await screen.findByText("feature/project-update")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset to main branch" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  });

  it("switches to main and hides reset after reset", async () => {
    const fetchSpy = rs.spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (String(input) === "/api/sync/reset" && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ projectPath: "apps" });
        return Response.json({
          state: "linked",
          ref: "main",
          defaultRef: "main",
          changes: { added: 0, modified: 0, removed: 0 },
        });
      }
      return Response.json({
        state: "linked",
        ref: "feature/project-update",
        defaultRef: "main",
        changes: { added: 0, modified: 0, removed: 0 },
      });
    }) as typeof fetch);

    render(<SyncStatusPanel path="apps" />);
    await userEvent.click(await screen.findByRole("button", { name: "Reset to main branch" }));

    expect(await screen.findByText("main")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset to main branch" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
  });

  it("refreshes status after a blocked reset so new local changes are shown", async () => {
    let statusReads = 0;
    const fetchSpy = rs.spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (String(input) === "/api/sync/reset" && init?.method === "POST") {
        return Response.json(
          { error: "Commit or restore local changes before resetting the branch" },
          { status: 409 },
        );
      }

      if (String(input).startsWith("/api/sync/status")) {
        statusReads += 1;
        return Response.json(
          statusReads === 1
            ? {
                state: "linked",
                ref: "feature/project-update",
                defaultRef: "main",
                changes: { added: 0, modified: 0, removed: 0 },
              }
            : {
                state: "ahead",
                ref: "feature/project-update",
                defaultRef: "main",
                changes: { added: 0, modified: 1, removed: 0 },
              },
        );
      }

      return Response.json({}, { status: 404 });
    }) as typeof fetch);

    render(<SyncStatusPanel path="apps" />);
    await userEvent.click(await screen.findByRole("button", { name: "Reset to main branch" }));

    expect(await screen.findByRole("button", { name: "1 local change" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset to main branch" })).toBeNull();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
  });
});

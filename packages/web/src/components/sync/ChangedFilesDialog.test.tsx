// @rstest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ChangedFile } from "@/lib/sync-api";
import { ChangedFilesDialog } from "./ChangedFilesDialog";

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function mockChanges(files: ChangedFile[]) {
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/sync/changes")) return Response.json({ files });
    return Response.json({}, { status: 404 });
  }) as typeof fetch);
}

describe("ChangedFilesDialog", () => {
  it("lists changed files with a per-kind summary", async () => {
    mockChanges([
      { path: "src/added.ts", change: "added" },
      { path: "src/deep/modified.ts", change: "modified" },
      { path: "src/removed.ts", change: "removed" },
    ]);

    render(
      <ChangedFilesDialog
        path="apps"
        remoteLabel="github.com/yunfanye/my-rome-apps"
        open
        onClose={() => {}}
      />,
    );

    // Summary reflects the counts once the fetch resolves.
    expect(await screen.findByText("3 files changed")).toBeTruthy();
    expect(screen.getByText("1 added")).toBeTruthy();
    expect(screen.getByText("1 modified")).toBeTruthy();
    expect(screen.getByText("1 removed")).toBeTruthy();

    // Each file's basename is rendered.
    const list = screen.getByRole("list");
    expect(within(list).getByText("added.ts")).toBeTruthy();
    expect(within(list).getByText("modified.ts")).toBeTruthy();
    expect(within(list).getByText("removed.ts")).toBeTruthy();

    // The directory prefix is shown for nested files.
    expect(within(list).getByText("src/deep/")).toBeTruthy();

    // Undo actions use the permanent destructive treatment, not hover-only color.
    expect(screen.getByRole("button", { name: "Undo all" }).dataset.variant).toBe("destructive");
    expect(screen.getByRole("button", { name: "Undo src/added.ts" }).dataset.variant).toBe(
      "destructive",
    );
  });

  it("shows an in-sync empty state when there are no changes", async () => {
    mockChanges([]);

    render(<ChangedFilesDialog path="apps" open onClose={() => {}} />);

    expect(await screen.findByText(/No local changes/i)).toBeTruthy();
  });

  it("opens the actual unified diff when a file is clicked", async () => {
    const fetchSpy = rs.spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
    ) => {
      const url = String(input);
      if (url.startsWith("/api/sync/changes/diff")) {
        return Response.json({
          path: "src/modified.ts",
          patch: [
            "diff --git a/src/modified.ts b/src/modified.ts",
            "--- a/src/modified.ts",
            "+++ b/src/modified.ts",
            "@@ -1,2 +1,2 @@",
            " const value = 1;",
            "-const oldName = true;",
            "+const newName = true;",
          ].join("\n"),
        });
      }
      if (url.startsWith("/api/sync/changes")) {
        return Response.json({ files: [{ path: "src/modified.ts", change: "modified" }] });
      }
      return Response.json({}, { status: 404 });
    }) as typeof fetch);

    render(<ChangedFilesDialog path="apps" open onClose={() => {}} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "View diff for src/modified.ts" }),
    );

    expect(await screen.findByText("+const newName = true;")).toBeTruthy();
    expect(screen.getByText("-const oldName = true;")).toBeTruthy();
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to changed files" })).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/sync/changes/diff?projectPath=apps&path=src%2Fmodified.ts",
      { credentials: "include" },
    );
  });

  it("shows a focused error when the selected diff cannot load", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sync/changes/diff")) {
        return Response.json({ error: "Diff is no longer available" }, { status: 409 });
      }
      return Response.json({ files: [{ path: "changed.ts", change: "modified" }] });
    }) as typeof fetch);

    render(<ChangedFilesDialog path="apps" open onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "View diff for changed.ts" }));

    expect(await screen.findByText("Diff is no longer available")).toBeTruthy();
  });

  it("undoes a changed file from its row", async () => {
    const files: ChangedFile[] = [{ path: "src/modified.ts", change: "modified" }];
    const fetchSpy = rs.spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url === "/api/sync/changes/restore" && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          projectPath: "apps",
          path: "src/modified.ts",
        });
        return Response.json({ files: [] });
      }
      if (url.startsWith("/api/sync/changes")) return Response.json({ files });
      return Response.json({}, { status: 404 });
    }) as typeof fetch);
    const onChangesRestored = rs.fn();

    render(
      <ChangedFilesDialog
        path="apps"
        open
        onClose={() => {}}
        onChangesRestored={onChangesRestored}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Undo src/modified.ts" }));

    expect(await screen.findByText(/No local changes/i)).toBeTruthy();
    expect(onChangesRestored).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps the file visible and shows an error when undo fails", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (init?.method === "POST") {
        return Response.json({ error: "Could not restore file" }, { status: 409 });
      }
      if (String(input).startsWith("/api/sync/changes")) {
        return Response.json({ files: [{ path: "kept.ts", change: "modified" }] });
      }
      return Response.json({}, { status: 404 });
    }) as typeof fetch);

    render(<ChangedFilesDialog path="apps" open onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Undo kept.ts" }));

    expect(await screen.findByText("Could not restore file")).toBeTruthy();
    expect(screen.getByText("kept.ts")).toBeTruthy();
  });

  it("undoes every changed file from the summary", async () => {
    const files: ChangedFile[] = [
      { path: "src/one.ts", change: "modified" },
      { path: "src/two.ts", change: "added" },
    ];
    const fetchSpy = rs.spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url === "/api/sync/changes/restore-all" && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ projectPath: "apps" });
        return Response.json({ files: [] });
      }
      if (url.startsWith("/api/sync/changes")) return Response.json({ files });
      return Response.json({}, { status: 404 });
    }) as typeof fetch);
    const onChangesRestored = rs.fn();

    render(
      <ChangedFilesDialog
        path="apps"
        open
        onClose={() => {}}
        onChangesRestored={onChangesRestored}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Undo all" }));

    expect(await screen.findByText(/No local changes/i)).toBeTruthy();
    expect(onChangesRestored).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("clears the previous file list when loading a different project", async () => {
    let secondFetchStarted = false;
    let resolveSecondFetch: ((response: Response) => void) | undefined;
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("projectPath=apps")) {
        return Response.json({ files: [{ path: "old-project.ts", change: "modified" }] });
      }
      if (url.includes("projectPath=notes")) {
        secondFetchStarted = true;
        return new Promise<Response>((resolve) => {
          resolveSecondFetch = resolve;
        });
      }
      return Response.json({}, { status: 404 });
    }) as typeof fetch);

    const { rerender } = render(<ChangedFilesDialog path="apps" open onClose={() => {}} />);
    expect(await screen.findByText("old-project.ts")).toBeTruthy();

    rerender(<ChangedFilesDialog path="notes" open onClose={() => {}} />);

    await waitFor(() => expect(secondFetchStarted).toBe(true));
    await waitFor(() => expect(screen.queryByText("old-project.ts")).toBeNull());

    resolveSecondFetch?.(Response.json({ error: "Could not list changes" }, { status: 500 }));

    expect(await screen.findByText("Could not list changes")).toBeTruthy();
    expect(screen.queryByText("old-project.ts")).toBeNull();
  });

  it("does not fetch while closed", () => {
    const fetchSpy = rs.spyOn(globalThis, "fetch");
    render(<ChangedFilesDialog path="apps" open={false} onClose={() => {}} />);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

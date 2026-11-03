// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { renderHook, waitFor } from "@testing-library/react";
import { useResolvedSelection } from "./useResolvedSelection";

afterEach(() => {
  rs.unstubAllGlobals();
});

function stubResolve(type: string) {
  const fetchMock = rs.fn(async () => new Response(JSON.stringify({ type }), { status: 200 }));
  rs.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("useResolvedSelection", () => {
  it("restores a saved folder as a folder through the scoped resolve endpoint", async () => {
    const fetchMock = stubResolve("directory");
    const { result } = renderHook(() =>
      useResolvedSelection("/api/share/tok/projects", "projects/docs"),
    );
    await waitFor(() =>
      expect(result.current).toEqual({
        selection: { path: "projects/docs", type: "directory" },
        missing: false,
      }),
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/share/tok/projects/resolve?path=projects%2Fdocs",
    );
  });

  it("restores a saved file as a file", async () => {
    stubResolve("file");
    const { result } = renderHook(() => useResolvedSelection("/api/projects", "projects/a.md"));
    await waitFor(() =>
      expect(result.current.selection).toEqual({ path: "projects/a.md", type: "file" }),
    );
  });

  it("selects nothing without a path", () => {
    const fetchMock = stubResolve("file");
    const { result } = renderHook(() => useResolvedSelection("/api/projects", null));
    expect(result.current).toEqual({ selection: null, missing: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a missing path only once /resolve says so", async () => {
    stubResolve("missing");
    const { result } = renderHook(() => useResolvedSelection("/api/projects", "projects/gone"));
    expect(result.current).toEqual({ selection: null, missing: false });
    await waitFor(() => expect(result.current).toEqual({ selection: null, missing: true }));
  });

  it("does not treat a failed lookup as missing", async () => {
    const fetchMock = rs.fn(async () => new Response("", { status: 503 }));
    rs.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useResolvedSelection("/api/projects", "projects/a.md"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current).toEqual({ selection: null, missing: false });
  });

  it("keeps the previous selection while the next path resolves", async () => {
    let release: (() => void) | undefined;
    rs.stubGlobal(
      "fetch",
      rs.fn(async (url: string) => {
        if (url.includes("b.md")) await new Promise<void>((resolve) => (release = resolve));
        return new Response(JSON.stringify({ type: "file" }), { status: 200 });
      }),
    );
    const { result, rerender } = renderHook(
      ({ path }) => useResolvedSelection("/api/projects", path),
      { initialProps: { path: "projects/a.md" } },
    );
    await waitFor(() => expect(result.current.selection?.path).toBe("projects/a.md"));
    rerender({ path: "projects/b.md" });
    expect(result.current.selection?.path).toBe("projects/a.md");
    release?.();
    await waitFor(() => expect(result.current.selection?.path).toBe("projects/b.md"));
  });
});

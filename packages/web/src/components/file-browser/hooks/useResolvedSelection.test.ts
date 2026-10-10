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
      expect(result.current).toEqual({ path: "projects/docs", type: "directory" }),
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/share/tok/projects/resolve?path=projects%2Fdocs",
    );
  });

  it("restores a saved file as a file", async () => {
    stubResolve("file");
    const { result } = renderHook(() => useResolvedSelection("/api/projects", "projects/a.md"));
    await waitFor(() => expect(result.current).toEqual({ path: "projects/a.md", type: "file" }));
  });

  it("selects nothing without a path", () => {
    const fetchMock = stubResolve("file");
    const { result } = renderHook(() => useResolvedSelection("/api/projects", null));
    expect(result.current).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

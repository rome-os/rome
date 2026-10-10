// @rstest-environment jsdom
// Its own file: `serverRenderedName` reads the document's title and path once at
// module load, so the fixture has to be in place before the import runs.
import { describe, expect, it } from "@rstest/core";

describe("serverRenderedName", () => {
  it("returns the name the server rendered, for the path the document loaded at", async () => {
    document.title = "Reddit Radar · Rome";
    const { serverRenderedName } = await import("./page-title");

    expect(serverRenderedName(window.location.pathname)).toBe("Reddit Radar");
    // A client-side navigation lands on a path the server did not title, and the
    // page that renders it must not inherit the previous page's name.
    expect(serverRenderedName("/settings")).toBeNull();
  });
});

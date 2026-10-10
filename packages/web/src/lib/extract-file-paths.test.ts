import { describe, expect, it } from "@rstest/core";
import { extractFilePathsFromText } from "./extract-file-paths";

describe("extractFilePathsFromText", () => {
  it("returns empty for empty content", () => {
    expect(extractFilePathsFromText("")).toEqual([]);
  });

  it("extracts a projects link with backticks in the label", () => {
    const content =
      "已完成。\n- [`00-overall-effect.png`](</projects/default/screenshots/icon-merch-20260528/00-overall-effect.png>) — 整体效果合成图";
    expect(extractFilePathsFromText(content)).toEqual([
      "/projects/default/screenshots/icon-merch-20260528/00-overall-effect.png",
    ]);
  });

  it("extracts multiple projects links in order and deduplicates", () => {
    const content = [
      "Created:",
      "- [a.png](</projects/default/a.png>)",
      "- [b.png](</projects/default/b.png>)",
      "- [a.png again](</projects/default/a.png>)",
    ].join("\n");
    expect(extractFilePathsFromText(content)).toEqual([
      "/projects/default/a.png",
      "/projects/default/b.png",
    ]);
  });

  it("ignores markdown links that are not rooted at /projects/", () => {
    const content = [
      "[external](https://example.com)",
      "[bare](/etc/passwd)",
      "[no-brackets](/projects/default/skip.png)",
      "[ok](</projects/default/keep.png>)",
    ].join("\n");
    expect(extractFilePathsFromText(content)).toEqual(["/projects/default/keep.png"]);
  });

  it("returns empty when there are no projects links", () => {
    const content = "just text, no links";
    expect(extractFilePathsFromText(content)).toEqual([]);
  });
});

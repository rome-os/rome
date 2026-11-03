// @rstest-environment jsdom
import { describe, expect, it } from "@rstest/core";
import { defaultUrlTransform } from "@rome-os/ui/markdown";
import { transformMarkdownUrl } from "./markdown-url";

const image = { type: "element" as const, tagName: "img", properties: {}, children: [] };
const anchor = { ...image, tagName: "a" };

describe("transformMarkdownUrl", () => {
  it.each([
    ["/projects/demo/preview.png", "projects/demo/preview.png"],
    ["/memory/photos/preview.png", "memory/photos/preview.png"],
    ["/projects/demo/调色版/正面.png", "projects/demo/调色版/正面.png"],
    ["/projects/demo/%E6%AD%A3%E9%9D%A2.png", "projects/demo/正面.png"],
    ["/projects/demo/image%20one.png", "projects/demo/image one.png"],
    ["/projects/demo/100%25%20%23%3F%26.png", "projects/demo/100% #?&.png"],
    ["/projects/demo/literal%2520.png", "projects/demo/literal%20.png"],
    ["/projects/demo/preview.png?version=1#preview", "projects/demo/preview.png"],
  ])("maps %s to the scoped asset endpoint", (source, logicalPath) => {
    const result = new URL(transformMarkdownUrl(source, "src", image)!, window.location.origin);
    const root = logicalPath.split("/")[0];
    const fileName = logicalPath.slice(logicalPath.lastIndexOf("/") + 1);

    expect(result.pathname).toBe(`/api/${root}/asset/${encodeURIComponent(fileName)}`);
    expect(result.searchParams.get("path")).toBe(logicalPath);
  });

  it("maps same-origin absolute file URLs", () => {
    expect(
      transformMarkdownUrl(`${window.location.origin}/projects/demo/preview.png`, "src", image),
    ).toBe(transformMarkdownUrl("/projects/demo/preview.png", "src", image));
  });

  it.each([
    "https://example.com/projects/demo/preview.png",
    "//example.com/projects/demo/preview.png",
    "/api/projects/asset?path=projects%2Fdemo%2Fpreview.png",
    "/apps/demo/preview.png",
    "./preview.png",
  ])("leaves other image URLs unchanged: %s", (source) => {
    expect(transformMarkdownUrl(source, "src", image)).toBe(source);
  });

  it("preserves navigation links and other element attributes", () => {
    const source = "/projects/demo/preview.png";
    expect(transformMarkdownUrl(source, "href", anchor)).toBe(source);
    expect(transformMarkdownUrl(source, "src", { ...image, tagName: "video" })).toBe(source);
  });

  it.each([
    "/projects/demo/%ZZ.png",
    "/projects/demo/../preview.png",
    "/projects/demo/%2E%2E/preview.png",
    "/projects/demo/a%2Fb.png",
    "/projects/demo/a%5Cb.png",
    "/projects/demo//preview.png",
  ])("rejects invalid file paths: %s", (source) => {
    expect(transformMarkdownUrl(source, "src", image)).toBe("");
  });

  it("preserves the default transform for non-file URLs", () => {
    for (const source of [
      "javascript:alert(1)",
      "mailto:team@example.com",
      "data:image/png;base64,AA==",
    ]) {
      expect(transformMarkdownUrl(source, "src", image)).toBe(
        defaultUrlTransform(source, "src", image),
      );
      expect(transformMarkdownUrl(source, "href", anchor)).toBe(
        defaultUrlTransform(source, "href", anchor),
      );
    }
  });
});

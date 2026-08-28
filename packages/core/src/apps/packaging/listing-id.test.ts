import { describe, expect, it } from "@rstest/core";

import { parseListingId } from "./listing-id.js";

describe("parseListingId", () => {
  it("parses an unscoped name", () => {
    expect(parseListingId("xiaohongshu")).toEqual({
      scoped: false,
      handle: "xiaohongshu",
      slug: "",
      id: "xiaohongshu",
    });
  });

  it("parses a scoped @handle/slug", () => {
    expect(parseListingId("@alice/notes")).toEqual({
      scoped: true,
      handle: "alice",
      slug: "notes",
      id: "@alice/notes",
    });
  });

  it("accepts scoped slugs with underscores and leading digits", () => {
    expect(parseListingId("@alice/2048_game")).toMatchObject({ slug: "2048_game" });
  });

  it.each([
    ["empty string", ""],
    ["single char (below 2-char minimum)", "x"],
    ["uppercase", "XiaoHongShu"],
    ["leading hyphen", "-abc"],
    ["trailing hyphen", "abc-"],
    ["unscoped name with underscore (handle grammar)", "my_app"],
    ["unscoped name with slash but no @", "alice/notes"],
    ["@ with no slash", "@alice"],
    ["@ with empty handle", "@/notes"],
    ["@ with empty slug", "@alice/"],
    ["slug equal to handle (@x/x forbidden)", "@alice/alice"],
    ["handle with underscore", "@my_handle/notes"],
    ["33-char handle (above maximum)", `@${"a".repeat(33)}/notes`],
    ["65-char slug (above maximum)", `@alice/${"a".repeat(65)}`],
    ["extra path segment", "@alice/notes/extra"],
    ["URL-shaped string", "javascript://not-a-bundle-path"],
    ["https URL", "https://rome-cloud.example.com/api/store/listings/xiaohongshu"],
    ["whitespace inside slug", "@alice/a space"],
  ])("rejects %s", (_label, input) => {
    expect(parseListingId(input)).toBeNull();
  });

  it("accepts boundary lengths: 2-char and 32-char handles, 64-char slugs", () => {
    expect(parseListingId("ab")).not.toBeNull();
    expect(parseListingId("a".repeat(32))).not.toBeNull();
    expect(parseListingId(`@alice/${"a".repeat(64)}`)).not.toBeNull();
  });
});

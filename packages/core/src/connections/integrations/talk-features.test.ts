import { describe, expect, it } from "@rstest/core";
import { directoryCursorOffset, directoryPage } from "./talk-features.js";

describe("directoryPage", () => {
  it("pages an in-memory directory to its end, however deep", () => {
    const items = Array.from({ length: 20_001 }, (_, n) => n);
    const listed: number[] = [];
    let cursor: string | undefined;
    do {
      const page = directoryPage(items, { limit: 10_000, ...(cursor ? { cursor } : {}) });
      listed.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);

    expect(listed).toEqual(items);
  });

  it("refuses a cursor past the offset a fetching directory reaches", () => {
    const deep = Buffer.from("10001", "utf8").toString("base64url");

    expect(() => directoryCursorOffset(deep)).toThrow("at most 10000");
    expect(directoryCursorOffset(Buffer.from("10000", "utf8").toString("base64url"))).toBe(10_000);
  });
});

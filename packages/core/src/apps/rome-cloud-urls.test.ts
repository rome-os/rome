import { describe, expect, it } from "@rstest/core";
import {
  normalizeListingId,
  resolveBundleUrl,
  resolveListingDetailUrl,
} from "./rome-cloud-urls.js";

const ORIGIN = "https://rome-cloud.example.com";
const noOrigin = () => null;
const withOrigin = () => ORIGIN;

describe("normalizeListingId", () => {
  it("parses logical unscoped ids", () => {
    expect(normalizeListingId("xiaohongshu")?.id).toBe("xiaohongshu");
  });

  it("parses logical scoped ids", () => {
    expect(normalizeListingId("@alice/notes")?.id).toBe("@alice/notes");
  });

  it("extracts the logical id from a legacy unscoped bundle URL", () => {
    expect(
      normalizeListingId(`${ORIGIN}/api/store/listings/xiaohongshu/versions/1.0.0/bundle`)?.id,
    ).toBe("xiaohongshu");
  });

  it("extracts the logical id from a legacy scoped bundle URL (literal @)", () => {
    expect(
      normalizeListingId(`${ORIGIN}/api/store/listings/@alice/notes/versions/1.0.0/bundle`)?.id,
    ).toBe("@alice/notes");
  });

  it("extracts the logical id from a legacy scoped bundle URL with percent-encoded @", () => {
    expect(
      normalizeListingId(`${ORIGIN}/api/store/listings/%40alice/notes/versions/1.0.0/bundle`)?.id,
    ).toBe("@alice/notes");
  });

  it("extracts the logical id from a legacy listing-detail URL", () => {
    expect(normalizeListingId(`${ORIGIN}/api/store/listings/xiaohongshu`)?.id).toBe("xiaohongshu");
    expect(normalizeListingId(`${ORIGIN}/api/store/listings/@alice/notes`)?.id).toBe(
      "@alice/notes",
    );
  });

  it("rejects a logical id that violates the listing-id grammar", () => {
    expect(normalizeListingId("Not A Slug")).toBeNull();
    expect(normalizeListingId("@alice")).toBeNull();
  });

  it("rejects a legacy URL whose extracted id violates the grammar", () => {
    // "a space" can never be a published slug, so a URL carrying it is garbage.
    expect(
      normalizeListingId(`${ORIGIN}/api/store/listings/@alice/a%20space/versions/1/bundle`),
    ).toBeNull();
  });

  it("returns null for an unrecognisable URL", () => {
    expect(normalizeListingId(`${ORIGIN}/totally/unrelated/path`)).toBeNull();
  });

  it("returns null for URL-shaped strings that never reach the logical-id path", () => {
    expect(normalizeListingId("not a url://oops")).toBeNull();
    expect(normalizeListingId("javascript://not-a-bundle-path")).toBeNull();
  });
});

describe("resolveBundleUrl", () => {
  it("builds the bundle URL from a logical unscoped id", () => {
    expect(resolveBundleUrl("xiaohongshu", "1.2.3", withOrigin).toString()).toBe(
      `${ORIGIN}/api/store/listings/xiaohongshu/versions/1.2.3/bundle`,
    );
  });

  it("builds the bundle URL from a logical scoped id", () => {
    expect(resolveBundleUrl("@alice/notes", "1.2.3", withOrigin).toString()).toBe(
      `${ORIGIN}/api/store/listings/@alice/notes/versions/1.2.3/bundle`,
    );
  });

  it("re-derives the bundle URL from a legacy URL form (origin gets replaced)", () => {
    const legacy =
      "https://old-origin.example.com/api/store/listings/xiaohongshu/versions/1.0.0/bundle";
    expect(resolveBundleUrl(legacy, "1.0.0", withOrigin).toString()).toBe(
      `${ORIGIN}/api/store/listings/xiaohongshu/versions/1.0.0/bundle`,
    );
  });

  it("throws when the input is neither a logical id nor a recognisable URL", () => {
    expect(() => resolveBundleUrl("not a url://oops", "1.0.0", withOrigin)).toThrowError(
      /neither a logical id nor a recognisable Rome Cloud URL/,
    );
  });

  it("throws when the registry origin is not configured", () => {
    expect(() => resolveBundleUrl("xiaohongshu", "1.0.0", noOrigin)).toThrowError(
      /registry origin is not configured/,
    );
  });
});

describe("resolveListingDetailUrl", () => {
  it("builds the listing-detail URL from a logical unscoped id", () => {
    expect(resolveListingDetailUrl("xiaohongshu", withOrigin)?.toString()).toBe(
      `${ORIGIN}/api/store/listings/xiaohongshu`,
    );
  });

  it("builds the listing-detail URL from a logical scoped id", () => {
    expect(resolveListingDetailUrl("@alice/notes", withOrigin)?.toString()).toBe(
      `${ORIGIN}/api/store/listings/@alice/notes`,
    );
  });

  it("returns null for an unrecognisable input (best-effort callers)", () => {
    expect(resolveListingDetailUrl("not a url://oops", withOrigin)).toBeNull();
  });

  it("returns null when the registry origin is not configured", () => {
    expect(resolveListingDetailUrl("xiaohongshu", noOrigin)).toBeNull();
  });
});

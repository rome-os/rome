// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { readStored, readStoredJson, writeStored, writeStoredJson } from "./stored-preference";

describe("stored preference", () => {
  afterEach(() => {
    rs.restoreAllMocks();
    window.localStorage.clear();
  });

  it("reads back what it wrote, and removes the key for null", () => {
    writeStored("k", "grid");
    expect(readStored("k")).toBe("grid");
    writeStored("k", null);
    expect(readStored("k")).toBeNull();
  });

  it("reads JSON back, and undefined for nothing stored or text that is not JSON", () => {
    writeStoredJson("k", ["a", "b"]);
    expect(readStoredJson("k")).toEqual(["a", "b"]);
    expect(readStoredJson("missing")).toBeUndefined();
    window.localStorage.setItem("k", "{not json");
    expect(readStoredJson("k")).toBeUndefined();
  });

  it("reads nothing and writes nothing, without throwing, when storage is blocked", () => {
    rs.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    rs.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(readStored("k")).toBeNull();
    expect(readStoredJson("k")).toBeUndefined();
    expect(() => writeStored("k", "v")).not.toThrow();
  });
});

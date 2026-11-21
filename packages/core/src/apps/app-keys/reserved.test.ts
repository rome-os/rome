import { describe, expect, it } from "@rstest/core";
import { appKeyNameError } from "@rome/api-types/app-keys";

describe("appKeyNameError", () => {
  it("accepts well-formed names", () => {
    expect(appKeyNameError("TAELOR_DB_PASSWORD")).toBeNull();
    expect(appKeyNameError("MY_API_KEY")).toBeNull();
    expect(appKeyNameError("X")).toBeNull();
    expect(appKeyNameError("A1_B2")).toBeNull();
  });

  it("rejects malformed names", () => {
    expect(appKeyNameError("")).toMatch(/required/);
    expect(appKeyNameError("lowercase")).toMatch(/uppercase/);
    expect(appKeyNameError("1STARTS_WITH_DIGIT")).toMatch(/start with a letter/);
    expect(appKeyNameError("HAS-DASH")).toMatch(/uppercase/);
    expect(appKeyNameError("HAS SPACE")).toMatch(/uppercase/);
    expect(appKeyNameError("A".repeat(65))).toMatch(/at most 64/);
  });

  it("rejects platform-reserved names and prefixes", () => {
    expect(appKeyNameError("PATH")).toMatch(/reserved/);
    expect(appKeyNameError("HOME")).toMatch(/reserved/);
    expect(appKeyNameError("ROME_PROFILE")).toMatch(/reserved/);
    expect(appKeyNameError("ANTHROPIC_API_KEY")).toMatch(/reserved/);
    expect(appKeyNameError("DATABASE_TYPE")).toMatch(/reserved/);
    expect(appKeyNameError("INTERNAL_API_PORT")).toMatch(/reserved/);
    expect(appKeyNameError("NODE_OPTIONS")).toMatch(/reserved/);
    expect(appKeyNameError("STATSIG_SERVER_SECRET_KEY")).toMatch(/reserved/);
  });

  it("allows names that merely share letters with a reserved prefix", () => {
    // WEBHOOK_ is not WEB_ + separator; ROMEO_ is not ROME_.
    expect(appKeyNameError("WEBHOOK_SECRET")).toBeNull();
    expect(appKeyNameError("ROMEO_KEY")).toBeNull();
  });
});

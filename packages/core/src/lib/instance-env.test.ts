import { describe, expect, it } from "@rstest/core";
import {
  applyInstanceSlug,
  decideAdoptedSlug,
  deriveInstanceOrigin,
  isInstanceSlug,
  readEnvInstanceOrigin,
  readEnvInstanceSlug,
  readEnvInstanceToken,
} from "./instance-env.js";

describe("readEnvInstanceSlug", () => {
  it("returns the trimmed slug", () => {
    expect(readEnvInstanceSlug({ PANTHEON_SLUG: "  acme  " })).toBe("acme");
  });

  it("returns undefined when unset or blank", () => {
    expect(readEnvInstanceSlug({})).toBeUndefined();
    expect(readEnvInstanceSlug({ PANTHEON_SLUG: "   " })).toBeUndefined();
  });
});

describe("readEnvInstanceOrigin", () => {
  it("returns the raw value without trimming or validating", () => {
    expect(readEnvInstanceOrigin({ PANTHEON_INSTANCE_ORIGIN: " not a url " })).toBe(" not a url ");
  });

  it("returns undefined when unset", () => {
    expect(readEnvInstanceOrigin({})).toBeUndefined();
  });
});

describe("readEnvInstanceToken", () => {
  it("returns the trimmed token", () => {
    expect(readEnvInstanceToken({ ROME_INSTANCE_TOKEN: "  romeinst_abc  " })).toBe("romeinst_abc");
  });

  it("returns undefined when unset", () => {
    expect(readEnvInstanceToken({})).toBeUndefined();
  });

  it("ignores the token under ROME_DEV_SKIP_TOKEN_SEED=1", () => {
    expect(
      readEnvInstanceToken({ ROME_INSTANCE_TOKEN: "romeinst_abc", ROME_DEV_SKIP_TOKEN_SEED: "1" }),
    ).toBeUndefined();
  });

  it("only skips on the exact value 1", () => {
    expect(
      readEnvInstanceToken({ ROME_INSTANCE_TOKEN: "romeinst_abc", ROME_DEV_SKIP_TOKEN_SEED: "0" }),
    ).toBe("romeinst_abc");
  });
});

describe("isInstanceSlug", () => {
  it.each(["a", "acme", "acme-7", "7acme", "a".repeat(63)])("accepts %s", (slug) => {
    expect(isInstanceSlug(slug)).toBe(true);
  });

  it.each([
    "",
    "Acme",
    "-acme",
    "acme-",
    "a.b",
    "a b",
    "a_b",
    "a".repeat(64),
    1,
    null,
    undefined,
  ])("rejects %j", (slug) => {
    expect(isInstanceSlug(slug)).toBe(false);
  });
});

describe("deriveInstanceOrigin", () => {
  it("joins the slug and PANTHEON_DOMAIN, trimming stray dots and spaces", () => {
    expect(deriveInstanceOrigin("acme", { PANTHEON_DOMAIN: " .romeos.cc. " })).toBe(
      "https://acme.romeos.cc",
    );
  });

  it("returns null when there is no domain", () => {
    expect(deriveInstanceOrigin("acme", {})).toBeNull();
    expect(deriveInstanceOrigin("acme", { PANTHEON_DOMAIN: "  " })).toBeNull();
  });
});

describe("applyInstanceSlug", () => {
  it("sets the slug and overwrites an explicit pool origin", () => {
    const env: NodeJS.ProcessEnv = {
      PANTHEON_DOMAIN: "romeos.cc",
      PANTHEON_SLUG: "pool-7",
      PANTHEON_INSTANCE_ORIGIN: "https://pool-7.romeos.cc",
    };

    expect(applyInstanceSlug("acme", env)).toBe("https://acme.romeos.cc");

    expect(env.PANTHEON_SLUG).toBe("acme");
    expect(env.PANTHEON_INSTANCE_ORIGIN).toBe("https://acme.romeos.cc");
    expect(readEnvInstanceSlug(env)).toBe("acme");
    expect(readEnvInstanceOrigin(env)).toBe("https://acme.romeos.cc");
  });

  it("changes nothing when the instance is not hosted", () => {
    const env: NodeJS.ProcessEnv = { PANTHEON_SLUG: "local" };

    expect(applyInstanceSlug("acme", env)).toBeNull();

    expect(env).toEqual({ PANTHEON_SLUG: "local" });
  });
});

describe("decideAdoptedSlug", () => {
  const stored = { from: "pool-7", to: "acme" };

  it("does nothing without a stored adoption", () => {
    expect(decideAdoptedSlug(null, "pool-7")).toEqual({ action: "none" });
    expect(decideAdoptedSlug(undefined, undefined)).toEqual({ action: "none" });
  });

  it("applies the adopted slug while the env still holds the slug it replaced", () => {
    expect(decideAdoptedSlug(stored, "pool-7")).toEqual({ action: "apply", slug: "acme" });
  });

  it("applies when the pool had no slug and the env has none", () => {
    expect(decideAdoptedSlug({ from: null, to: "acme" }, undefined)).toEqual({
      action: "apply",
      slug: "acme",
    });
  });

  it("drops the record when the container was recreated with the adopted slug", () => {
    expect(decideAdoptedSlug(stored, "acme")).toEqual({ action: "discard" });
  });

  it("drops the record, leaving the env alone, after a later address change", () => {
    expect(decideAdoptedSlug(stored, "acme-2")).toEqual({ action: "discard" });
    expect(decideAdoptedSlug(stored, undefined)).toEqual({ action: "discard" });
  });

  it.each([
    "acme",
    42,
    {},
    { from: "pool-7" },
    { from: "pool-7", to: "Not A Label" },
    { from: 7, to: "acme" },
  ])("drops a malformed record %j", (record) => {
    expect(decideAdoptedSlug(record, "pool-7")).toEqual({ action: "discard" });
  });
});

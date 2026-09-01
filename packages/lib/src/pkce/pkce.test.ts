import { createHash } from "node:crypto";
import { describe, expect, it } from "@rstest/core";
import {
  CODE_CHALLENGE_RE,
  computeS256Challenge,
  createPkce,
  normalizeCodeChallenge,
  verifyPkceChallenge,
} from "./index";

describe("createPkce", () => {
  it("mints a verifier whose S256 challenge matches", () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toMatch(CODE_CHALLENGE_RE);
    expect(challenge).toMatch(CODE_CHALLENGE_RE);
    expect(challenge).toBe(computeS256Challenge(verifier));
    expect(verifyPkceChallenge(verifier, challenge)).toBe(true);
  });

  it("produces a distinct pair each call", () => {
    expect(createPkce().verifier).not.toBe(createPkce().verifier);
  });
});

describe("computeS256Challenge", () => {
  it("is base64url(sha256(verifier))", () => {
    const verifier = "a".repeat(43);
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(computeS256Challenge(verifier)).toBe(expected);
  });
});

describe("normalizeCodeChallenge", () => {
  it("accepts a well-formed challenge and trims it", () => {
    const c = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(normalizeCodeChallenge(` ${c} `)).toBe(c);
  });

  it("rejects malformed/empty/nullish", () => {
    expect(normalizeCodeChallenge("too-short")).toBeNull();
    expect(normalizeCodeChallenge("")).toBeNull();
    expect(normalizeCodeChallenge(null)).toBeNull();
    expect(normalizeCodeChallenge(undefined)).toBeNull();
  });
});

describe("verifyPkceChallenge", () => {
  it("is false for a mismatched verifier", () => {
    const { challenge } = createPkce();
    expect(verifyPkceChallenge(createPkce().verifier, challenge)).toBe(false);
  });

  it("rejects a malformed verifier before hashing", () => {
    expect(verifyPkceChallenge("bad verifier!", "x".repeat(43))).toBe(false);
  });
});

import { describe, expect, it } from "@rstest/core";
import {
  buildOriginPolicy,
  isInstanceUrl,
  parseOriginList,
  redactUrlForLog,
  resolveNavigation,
  type OriginPolicy,
} from "./origin-allowlist.js";

const policy: OriginPolicy = buildOriginPolicy({
  romeCloudOrigin: "https://rome.example",
  instanceDomain: "rome.example",
  authOrigins: ["https://accounts.google.com"],
});

describe("buildOriginPolicy", () => {
  it("throws when romeCloudOrigin is not a valid HTTPS URL", () => {
    expect(() =>
      buildOriginPolicy({ romeCloudOrigin: "http://rome.example", instanceDomain: "rome.example" }),
    ).toThrow();
    expect(() =>
      buildOriginPolicy({ romeCloudOrigin: "not a url", instanceDomain: "rome.example" }),
    ).toThrow();
    expect(() =>
      buildOriginPolicy({ romeCloudOrigin: "", instanceDomain: "rome.example" }),
    ).toThrow();
  });

  it("throws when instanceDomain is not a bare hostname", () => {
    expect(() =>
      buildOriginPolicy({ romeCloudOrigin: "https://rome.example", instanceDomain: "" }),
    ).toThrow();
    expect(() =>
      buildOriginPolicy({
        romeCloudOrigin: "https://rome.example",
        instanceDomain: "rome.example/path",
      }),
    ).toThrow();
    expect(() =>
      buildOriginPolicy({
        romeCloudOrigin: "https://rome.example",
        instanceDomain: "rome.example:8443",
      }),
    ).toThrow();
    expect(() =>
      buildOriginPolicy({
        romeCloudOrigin: "https://rome.example",
        instanceDomain: "https://rome.example",
      }),
    ).toThrow();
  });

  it("throws when instanceDomain is a single label (would trust arbitrary hosts)", () => {
    // `instanceDomain: "com"` would make isInstanceUrl accept https://evil.com.
    expect(() =>
      buildOriginPolicy({ romeCloudOrigin: "https://rome.example", instanceDomain: "com" }),
    ).toThrow();
    expect(() =>
      buildOriginPolicy({ romeCloudOrigin: "https://rome.example", instanceDomain: "localhost" }),
    ).toThrow();
    // Trailing-dot form contains a dot but is still a single label.
    expect(() =>
      buildOriginPolicy({ romeCloudOrigin: "https://rome.example", instanceDomain: "com." }),
    ).toThrow();
  });

  it("normalizes romeCloudOrigin to a bare origin", () => {
    const p = buildOriginPolicy({
      romeCloudOrigin: "https://rome.example/login?x=1",
      instanceDomain: "rome.example",
    });
    expect([...p.exactOrigins]).toEqual(["https://rome.example"]);
  });

  it("exposes the normalized Rome Cloud origin separately from exactOrigins", () => {
    const p = buildOriginPolicy({
      romeCloudOrigin: "https://rome.example/login?x=1",
      instanceDomain: "rome.example",
      authOrigins: ["https://accounts.google.com"],
    });
    expect(p.romeCloudOrigin).toBe("https://rome.example");
  });

  it("lowercases instanceDomain", () => {
    const p = buildOriginPolicy({
      romeCloudOrigin: "https://rome.example",
      instanceDomain: "Rome.Example",
    });
    expect(p.instanceDomain).toBe("rome.example");
  });

  it("silently drops invalid auth origins but keeps valid ones", () => {
    const p = buildOriginPolicy({
      romeCloudOrigin: "https://rome.example",
      instanceDomain: "rome.example",
      authOrigins: ["http://nope.example", "garbage", "https://accounts.google.com"],
    });
    expect(p.exactOrigins.has("https://accounts.google.com")).toBe(true);
    expect(p.exactOrigins.has("http://nope.example")).toBe(false);
    expect(p.exactOrigins.size).toBe(2);
  });
});

describe("isInstanceUrl", () => {
  it("accepts a single-label subdomain of the instance domain", () => {
    expect(isInstanceUrl("https://abc.rome.example", policy)).toBe(true);
    expect(isInstanceUrl("https://abc.rome.example/login?next=/", policy)).toBe(true);
  });

  it("accepts mixed-case hosts (URL lowercases hostnames)", () => {
    expect(isInstanceUrl("https://ABC.Rome.Example/x", policy)).toBe(true);
  });

  it("rejects the apex domain itself (that is Rome Cloud's exact match, not an instance)", () => {
    expect(isInstanceUrl("https://rome.example", policy)).toBe(false);
  });

  it("rejects multi-label subdomains", () => {
    expect(isInstanceUrl("https://a.b.rome.example", policy)).toBe(false);
  });

  it("rejects lookalike hosts without a dot boundary", () => {
    expect(isInstanceUrl("https://evil-rome.example", policy)).toBe(false);
    expect(isInstanceUrl("https://evilrome.example", policy)).toBe(false);
  });

  it("rejects a suffix-extended host (instance domain not at the end)", () => {
    expect(isInstanceUrl("https://abc.rome.example.evil.tld", policy)).toBe(false);
  });

  it("rejects non-default ports", () => {
    expect(isInstanceUrl("https://abc.rome.example:8443", policy)).toBe(false);
  });

  it("rejects non-HTTPS and malformed input", () => {
    expect(isInstanceUrl("http://abc.rome.example", policy)).toBe(false);
    expect(isInstanceUrl("rome://callback", policy)).toBe(false);
    expect(isInstanceUrl("not a url", policy)).toBe(false);
    expect(isInstanceUrl("", policy)).toBe(false);
  });

  it("rejects a trailing-dot host", () => {
    expect(isInstanceUrl("https://abc.rome.example./x", policy)).toBe(false);
  });

  it("rejects a percent-encoded dot suffix extension", () => {
    expect(isInstanceUrl("https://abc.rome.example%2Eevil.tld/", policy)).toBe(false);
  });

  it("does not let userinfo confuse the host check", () => {
    expect(isInstanceUrl("https://abc.rome.example@evil.com/", policy)).toBe(false);
  });

  it("rejects userinfo-bearing URLs even when the host is a real instance", () => {
    expect(isInstanceUrl("https://user:pass@abc.rome.example/", policy)).toBe(false);
    expect(isInstanceUrl("https://user@abc.rome.example/", policy)).toBe(false);
  });

  it("accepts an explicit default port (normalizes to default)", () => {
    expect(isInstanceUrl("https://abc.rome.example:443/x", policy)).toBe(true);
  });

  it("rejects reserved / operational sibling labels (not user instances)", () => {
    // Mirrors Rome Cloud's RESERVED_SLUGS plus known operational siblings
    // (demo = store preview, public-assets = static content, staging =
    // staging Rome Cloud).
    expect(isInstanceUrl("https://demo.rome.example/", policy)).toBe(false);
    expect(isInstanceUrl("https://public-assets.rome.example/logo.png", policy)).toBe(false);
    expect(isInstanceUrl("https://staging.rome.example/", policy)).toBe(false);
    expect(isInstanceUrl("https://www.rome.example/", policy)).toBe(false);
    expect(isInstanceUrl("https://api.rome.example/v1", policy)).toBe(false);
  });

  it("rejects labels that violate Rome Cloud's slug rules", () => {
    // Single character (slug minimum is 2).
    expect(isInstanceUrl("https://a.rome.example/", policy)).toBe(false);
    // Leading / trailing hyphen.
    expect(isInstanceUrl("https://-abc.rome.example/", policy)).toBe(false);
    expect(isInstanceUrl("https://abc-.rome.example/", policy)).toBe(false);
    // Underscore parses as a hostname character but is not a slug character.
    expect(isInstanceUrl("https://some_slug.rome.example/", policy)).toBe(false);
    // Longer than 32 characters.
    expect(isInstanceUrl(`https://${"a".repeat(33)}.rome.example/`, policy)).toBe(false);
    // 32 characters exactly is still a valid slug.
    expect(isInstanceUrl(`https://${"a".repeat(32)}.rome.example/`, policy)).toBe(true);
  });
});

describe("resolveNavigation", () => {
  it("routes the Rome Cloud origin into the shell", () => {
    expect(resolveNavigation("https://rome.example/dashboard", policy)).toEqual({
      kind: "in-shell",
      url: "https://rome.example/dashboard",
    });
  });

  it("routes an instance subdomain into the shell", () => {
    expect(resolveNavigation("https://abc.rome.example/login", policy)).toEqual({
      kind: "in-shell",
      url: "https://abc.rome.example/login",
    });
  });

  it("routes a configured auth origin into the shell", () => {
    expect(resolveNavigation("https://accounts.google.com/o/oauth2/v2/auth", policy)).toEqual({
      kind: "in-shell",
      url: "https://accounts.google.com/o/oauth2/v2/auth",
    });
  });

  it("routes valid off-list HTTPS to the system browser", () => {
    expect(resolveNavigation("https://github.com/login", policy)).toEqual({
      kind: "external",
      url: "https://github.com/login",
    });
  });

  it("routes reserved sibling subdomains to the system browser, not in-shell", () => {
    expect(resolveNavigation("https://demo.rome.example/", policy)).toEqual({
      kind: "external",
      url: "https://demo.rome.example/",
    });
    expect(resolveNavigation("https://public-assets.rome.example/logo.png", policy)).toEqual({
      kind: "external",
      url: "https://public-assets.rome.example/logo.png",
    });
  });

  it("drops non-HTTPS targets", () => {
    expect(resolveNavigation("http://abc.rome.example", policy)).toEqual({ kind: "drop" });
    expect(resolveNavigation("rome://callback?code=abc", policy)).toEqual({ kind: "drop" });
    expect(resolveNavigation("data:text/html,<h1>x</h1>", policy)).toEqual({ kind: "drop" });
    expect(resolveNavigation("about:blank", policy)).toEqual({ kind: "drop" });
  });

  it("drops malformed input", () => {
    expect(resolveNavigation("not a url", policy)).toEqual({ kind: "drop" });
    expect(resolveNavigation("", policy)).toEqual({ kind: "drop" });
  });

  it("drops userinfo-bearing HTTPS URLs, even to trusted hosts (fail-closed)", () => {
    expect(resolveNavigation("https://user:pass@accounts.google.com/signin", policy)).toEqual({
      kind: "drop",
    });
    expect(resolveNavigation("https://user:pass@abc.rome.example/", policy)).toEqual({
      kind: "drop",
    });
    expect(resolveNavigation("https://user@rome.example/dashboard", policy)).toEqual({
      kind: "drop",
    });
    // Off-policy userinfo URLs are dropped too, never handed to the browser.
    expect(resolveNavigation("https://user:pass@github.com/login", policy)).toEqual({
      kind: "drop",
    });
  });
});

describe("parseOriginList", () => {
  it("splits on commas and whitespace, trimming empties", () => {
    expect(parseOriginList("https://a.example, https://b.example\n https://c.example")).toEqual([
      "https://a.example",
      "https://b.example",
      "https://c.example",
    ]);
  });

  it("returns [] for null/undefined/empty", () => {
    expect(parseOriginList(null)).toEqual([]);
    expect(parseOriginList(undefined)).toEqual([]);
    expect(parseOriginList("")).toEqual([]);
  });
});

describe("redactUrlForLog", () => {
  it("keeps origin + path and strips query and fragment", () => {
    expect(redactUrlForLog("https://rome.example/authorize?state=secret#code=x")).toBe(
      "https://rome.example/authorize",
    );
  });

  it("returns a fixed marker for unparseable input", () => {
    expect(redactUrlForLog("not a url")).toBe("[unparsable url]");
  });

  it("redacts everything after the scheme for non-HTTP(S) URLs", () => {
    // For non-special schemes the WHATWG parser puts the entire payload in
    // `pathname`, so origin+pathname logging would echo it verbatim.
    expect(redactUrlForLog("javascript:alert(document.cookie)")).toBe("javascript:[redacted]");
    expect(redactUrlForLog("javascript:alert(document.cookie)")).not.toContain("cookie");
    expect(redactUrlForLog("data:text/html,<h1>secret</h1>")).toBe("data:[redacted]");
    expect(redactUrlForLog("rome://callback?code=abc")).toBe("rome:[redacted]");
    expect(redactUrlForLog("about:blank")).toBe("about:[redacted]");
  });

  it("still keeps origin + path for plain http", () => {
    expect(redactUrlForLog("http://rome.example/path?tok=x")).toBe("http://rome.example/path");
  });
});

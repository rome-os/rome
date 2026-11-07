import { describe, expect, it } from "@rstest/core";
import { AppManifestSchema } from "./manifest.js";

const base = { formatVersion: 1, id: "history", version: "0.0.1", description: "History" };

describe("public page path declarations", () => {
  it("accepts the same exact and prefix patterns as api.noAuth", () => {
    const paths = ["/", "/about", "/pr/*"];
    const app = AppManifestSchema.parse({
      ...base,
      web: { manifest: "web/manifest.json", publicPaths: paths },
      api: { noAuth: paths },
    });
    expect(app.web?.publicPaths).toEqual(app.api?.noAuth);
    expect(AppManifestSchema.parse(base).web).toBeUndefined();
  });

  it.each(
    [[], [""], ["pr/*"], true, "/*"].map((publicPaths) => ({ publicPaths })),
  )("rejects invalid publicPaths %j", ({ publicPaths }) => {
    expect(
      AppManifestSchema.safeParse({ ...base, web: { manifest: "web/manifest.json", publicPaths } })
        .success,
    ).toBe(false);
  });
});

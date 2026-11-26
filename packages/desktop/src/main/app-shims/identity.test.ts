import { describe, expect, it, rs } from "@rstest/core";
import { fetchAppIdentity, requireAppId } from "./identity";

const ORIGIN = "https://ray.romeos.cc";

function server(manifest: unknown, icon: Response = new Response(Buffer.from("png"))) {
  return rs.fn(async (url: string) => {
    if (url.endsWith(".webmanifest")) return Response.json(manifest);
    if (url.includes("/app-icon/")) return icon;
    return new Response(null, { status: 404 });
  });
}

describe("fetchAppIdentity", () => {
  it("reads the name, page and icon the Rome gives the app", async () => {
    const fetchImpl = server({
      name: "Recipes",
      start_url: "/full/apps/%40me%2Frecipes",
      icons: [{ src: "/app-icon/%40me%2Frecipes.png?v=1" }],
    });
    const identity = await fetchAppIdentity(fetchImpl, ORIGIN, "@me/recipes");
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      `${ORIGIN}/app-manifest/%40me%2Frecipes.webmanifest`,
      `${ORIGIN}/app-icon/%40me%2Frecipes.png?v=1`,
    ]);
    expect(identity).toEqual({
      name: "Recipes",
      url: `${ORIGIN}/full/apps/%40me%2Frecipes`,
      icon: Buffer.from("png"),
    });
  });

  it("refuses a page or icon on another site, or a page that is not an app page", async () => {
    await expect(
      fetchAppIdentity(
        server({ name: "A", start_url: "https://evil.example/full/apps/a" }),
        ORIGIN,
        "a",
      ),
    ).rejects.toThrow("another site");
    await expect(
      fetchAppIdentity(server({ name: "A", start_url: "/settings" }), ORIGIN, "a"),
    ).rejects.toThrow("not an app page");
    await expect(
      fetchAppIdentity(
        server({
          name: "A",
          start_url: "/full/apps/a",
          icons: [{ src: "https://evil.example/i.png" }],
        }),
        ORIGIN,
        "a",
      ),
    ).rejects.toThrow("another site");
  });

  it("fails for an app without a page", async () => {
    const fetchImpl = rs.fn(async () => new Response(null, { status: 404 }));
    await expect(fetchAppIdentity(fetchImpl, ORIGIN, "a")).rejects.toThrow("(404)");
  });

  it("has no icon when the Rome gives none", async () => {
    const identity = await fetchAppIdentity(
      server({ name: "A", start_url: "/full/apps/a" }),
      ORIGIN,
      "a",
    );
    expect(identity.icon).toBeNull();
  });
});

describe("requireAppId", () => {
  it("takes a slug or a scoped Store id, and nothing that could leave its path segment", () => {
    expect(requireAppId("recipes")).toBe("recipes");
    expect(requireAppId("@me/recipes")).toBe("@me/recipes");
    // Core's listing grammar: a slug may start with a digit and hold `_`.
    expect(requireAppId("@alice/2048")).toBe("@alice/2048");
    expect(requireAppId("@alice/my_app")).toBe("@alice/my_app");
    for (const bad of ["../x", "a/b", "", "Recipes", "@ab/ab", "@a/x", "@me/", 3, null]) {
      expect(() => requireAppId(bad)).toThrow();
    }
  });
});

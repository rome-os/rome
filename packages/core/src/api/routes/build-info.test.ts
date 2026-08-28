import { describe, it, expect } from "@rstest/core";
import { Hono } from "hono";
import { buildInfoRoutes } from "./build-info.js";

describe("GET /build-info", () => {
  it("surfaces the boot version report alongside the build identity", async () => {
    const app = new Hono().route(
      "/",
      buildInfoRoutes({
        bootVersionReport: { upgradedSinceLastBoot: true, previousVersion: "1.1.0" },
      }),
    );

    const res = await app.request("/build-info");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      upgradedSinceLastBoot: true,
      previousVersion: "1.1.0",
    });
  });

  it("reports no upgrade on a boot whose version matches the last one", async () => {
    const app = new Hono().route(
      "/",
      buildInfoRoutes({
        bootVersionReport: { upgradedSinceLastBoot: false, previousVersion: "1.1.0" },
      }),
    );

    const body = await (await app.request("/build-info")).json();

    expect(body).toMatchObject({ upgradedSinceLastBoot: false });
  });
});

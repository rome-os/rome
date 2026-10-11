import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestApp, type TestApp } from "@rome-os/app-runtime/testing";
import { createAction as createHello } from "../src/actions/hello/index.js";
import { createApiHandler } from "../src/api/index.js";

// Runs the app's actions and API with no Rome daemon: an in-memory SQLite,
// a fake channels service, and appContext.runAction wired to the actions
// registered below. `tablePrefix` matches app.yaml's db.tablePrefix; also pass
// `migrationsFolder: new URL("../src/db/migrations", import.meta.url)` once
// app.yaml declares a db.
describe("__APP_ID__", () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp({ appId: "__APP_ID__", tablePrefix: "__APP_TABLE_PREFIX__" });
    await app.action("hello", createHello);
  });

  afterEach(() => app.close());

  it("greets", async () => {
    expect(await app.runAction("hello", { message: "hi" })).toEqual({
      status: "ok",
      data: { message: "hi" },
    });
  });

  it("reports status through the API", async () => {
    const response = await app.api(createApiHandler).request("GET", "status");
    expect(response).toMatchObject({ status: 200, body: { appId: "__APP_ID__", status: "ok" } });
  });
});

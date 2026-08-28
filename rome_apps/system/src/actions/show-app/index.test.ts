import { describe, expect, it } from "@rstest/core";
import type { ActionConfig, AppActionRuntimeDeps } from "@rome-os/app-runtime";

import { createAction } from "./index.js";

const CONFIG: ActionConfig = {
  name: "show_app",
  type: "system",
  description: "show an app on the workspace",
  complexity: "simple",
  speed: "fast",
  reliability: "high",
  sideEffects: "read-only",
};

function makeAction() {
  return createAction(CONFIG, {} as unknown as AppActionRuntimeDeps);
}

describe("show_app action", () => {
  it("places the named app on the current workspace", async () => {
    const result = await makeAction().execute({ appId: "workflow-studio" });

    expect(result).toEqual({
      status: "place_widget",
      placement: { appId: "workflow-studio" },
    });
  });

  it("threads route and scalar params through to the placement", async () => {
    const result = await makeAction().execute({
      appId: "orders",
      route: "orders/123",
      params: { expanded: true, tab: "history" },
    });

    expect(result).toEqual({
      status: "place_widget",
      placement: {
        appId: "orders",
        route: "orders/123",
        params: { expanded: true, tab: "history" },
      },
    });
  });

  it("rejects a call with no appId", async () => {
    const result = await makeAction().execute({ route: "orders/123" });

    expect(result.status).toBe("error");
  });

  it("rejects a non-scalar param value (params address a route, they are not a data payload)", async () => {
    const result = await makeAction().execute({
      appId: "orders",
      params: { order: { id: 123, items: [] } },
    });

    expect(result.status).toBe("error");
  });
});

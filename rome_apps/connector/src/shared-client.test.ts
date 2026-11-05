import { describe, expect, it, rs } from "@rstest/core";
import type { AppDbContext } from "@rome-os/app-runtime";
import * as composioLoginModule from "./api/composio-login.js" with { rstest: "importActual" };

const mocks = rs.hoisted(() => ({ readSessionApiKey: rs.fn(), pinnedProjectFor: rs.fn() }));

rs.mock("./api/composio-login.js", () => ({
  ...composioLoginModule,
  readSessionApiKey: mocks.readSessionApiKey,
}));
rs.mock("./api/composio-project.js", () => ({ pinnedProjectFor: mocks.pinnedProjectFor }));

const { loadConnectorClient } = await import("./shared.js");
const { ComposioClient, ComposioProjectUnconfirmedError } = await import(
  "./api/composio-client.js"
);

const db = {} as AppDbContext;

describe("loadConnectorClient", () => {
  it("refuses a user key whose project cannot be confirmed", async () => {
    mocks.readSessionApiKey.mockResolvedValue("uak_test");
    mocks.pinnedProjectFor.mockResolvedValue(null);
    await expect(loadConnectorClient(db)).rejects.toBeInstanceOf(ComposioProjectUnconfirmedError);
  });

  it("builds a client for a pinned user key, and for a project key with no pin", async () => {
    mocks.readSessionApiKey.mockResolvedValue("uak_test");
    mocks.pinnedProjectFor.mockResolvedValue({
      orgId: "ok_org",
      projectId: "pr_pinned",
      projectName: "Pinned",
    });
    await expect(loadConnectorClient(db)).resolves.toBeInstanceOf(ComposioClient);
    mocks.readSessionApiKey.mockResolvedValue("ak_test");
    mocks.pinnedProjectFor.mockResolvedValue(null);
    await expect(loadConnectorClient(db)).resolves.toBeInstanceOf(ComposioClient);
  });
});

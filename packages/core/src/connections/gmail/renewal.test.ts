import { afterEach, expect, it, rs } from "@rstest/core";
import { ActionRegistryImpl } from "../../apps/actions/registry.js";
import { createTestDb } from "../../test/db.js";
import { RenewalUnavailable } from "../errors.js";
import { makeOAuthProviderDescriptor } from "../integrations/oauth-providers.js";
import { DrizzleConnectionsRepository } from "../repository-db.js";
import { ConnectionRegistry } from "../registry.js";
import { GMAIL_READ_ACTION, registerGmailActions } from "./actions.js";

rs.mock("../oauth/provider-token-files.js", () => ({
  syncProviderTokenFile: rs.fn(),
  clearProviderTokenFile: rs.fn(),
}));
rs.mock("../integrations/github-shell-integration.js", () => ({
  syncGithubShellIntegrationForProvider: rs.fn(),
  clearGithubShellIntegrationForProvider: rs.fn(),
}));
afterEach(() => {
  rs.unstubAllGlobals();
});

it("recovers a Gmail read rejected during a Cloud renewal outage without reconnecting", async () => {
  const testDb = createTestDb();
  try {
    const registry = new ConnectionRegistry({
      repository: new DrizzleConnectionsRepository(testDb.db),
    });
    let offline = true;
    const refresh = rs.fn(async () => {
      if (offline) throw new RenewalUnavailable("Test Cloud outage");
      return {
        material: { accessToken: "test-renewed", refreshToken: "test-stable" },
        expiresAt: new Date(Date.now() + 3600_000),
      };
    });
    registry.register(
      makeOAuthProviderDescriptor("google", {
        beginRedirect: async () => "https://example.test",
        redeem: async () => {
          throw new Error("No real consent in tests");
        },
        refresh,
      }),
    );
    const connection = await registry.connect("google");
    await registry.giveGrant(
      "google",
      connection.id,
      "user",
      {
        material: { accessToken: "test-expired", refreshToken: "test-stable" },
        expiresAt: new Date(0),
      },
      {
        subject: "test-user",
        email: "guardian@example.com",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      },
    );
    await registry.renewExpiring(60_000);
    const fetch = rs
      .fn()
      .mockResolvedValueOnce(Response.json({}, { status: 401 }))
      .mockResolvedValue(Response.json({ emailAddress: "guardian@example.com" }));
    rs.stubGlobal("fetch", fetch);
    const actions = new ActionRegistryImpl();
    registerGmailActions(actions, registry);
    const read = actions.get(GMAIL_READ_ACTION)!;
    expect(await read.execute({ path: "/gmail/v1/users/me/profile" })).toMatchObject({
      status: "error",
    });
    await rs.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connection.state()).toBe("working");
    offline = false;
    await registry.renewExpiring(60_000);
    expect(await read.execute({ path: "/gmail/v1/users/me/profile" })).toMatchObject({
      status: "ok",
    });
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer test-renewed");
  } finally {
    testDb.close();
  }
});

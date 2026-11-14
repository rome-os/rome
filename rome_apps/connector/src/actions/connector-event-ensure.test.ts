import type { ActionConfig, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { beforeEach, describe, expect, it, rs } from "@rstest/core";

const readGithubOAuthToken = rs.fn();
rs.mock("../api/github-proxy.js", () => ({
  readGithubOAuthToken: () => readGithubOAuthToken(),
}));

const { createAction } = await import("./connector-event-ensure/index.js");

const RELAY_URL = "https://relay.example/h/mbox";

const config: ActionConfig = {
  name: "connector_event_ensure",
  type: "custom",
  description: "connector_event_ensure",
  complexity: "simple",
  speed: "moderate",
  reliability: "medium",
  sideEffects: "write",
};

beforeEach(() => {
  rs.clearAllMocks();
});

describe("connector_event_ensure action", () => {
  const deps = {
    appContext: { repositories: { settings: { get: async () => RELAY_URL, set: async () => {} } } },
  } as unknown as AppActionRuntimeDeps;
  const repoFilter = [{ field: "repository.full_name", equals: "acme/widgets" }];

  it("refuses an event it does not deliver", async () => {
    const result = await createAction(config, deps).execute({
      eventName: "provider:event:slack.message",
      filter: [],
    });
    expect(result).toEqual({
      status: "error",
      error: expect.stringMatching(
        /^connector_event_ensure handles provider:event:github\.\* and provider:event:gmail\.gmail_new_gmail_message, .*provider:event:googlecalendar\.googlecalendar_event_starting_soon_trigger.* events only, not "provider:event:slack\.message"$/,
      ),
    });
  });

  it("subscribes Gmail's new mail through the connected account, with no filter", async () => {
    const result = await createAction(config, deps).execute({
      eventName: "provider:event:gmail.gmail_new_gmail_message",
      filter: [],
    });
    // No Composio sign-in in tests: the Gmail path answers why it cannot subscribe.
    expect(result).toEqual({ status: "error", error: "Rome is not signed in to Composio." });
  });

  it("subscribes a Google Calendar event through the connected account, with no filter", async () => {
    const result = await createAction(config, deps).execute({
      eventName: "provider:event:googlecalendar.googlecalendar_event_starting_soon_trigger",
      filter: [],
    });
    expect(result).toEqual({ status: "error", error: "Rome is not signed in to Composio." });
  });

  it("refuses a filter without a repo or org before calling GitHub", async () => {
    const result = await createAction(config, deps).execute({
      eventName: "provider:event:github.workflow_run",
      filter: [{ field: "action", equals: "completed" }],
    });
    expect(result).toEqual({
      status: "error",
      error:
        "provider:event:github.workflow_run needs a filter on repository.full_name (owner/name) or organization.login",
    });
    expect(readGithubOAuthToken).not.toHaveBeenCalled();
  });

  it("says GitHub is not connected", async () => {
    readGithubOAuthToken.mockResolvedValueOnce(null);
    const result = await createAction(config, deps).execute({
      eventName: "provider:event:github.workflow_run",
      filter: repoFilter,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain('connect_account tool with {"kind":"github"}');
      expect(result.error).not.toMatch(/can.t be connected from here/);
    }
  });
});

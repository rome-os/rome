import type { ActionConfig, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { describe, expect, it } from "@rstest/core";
import { createAction } from "./connector-watch-normalize/index.js";

const config: ActionConfig = {
  name: "connector_watch_normalize",
  type: "custom",
  description: "connector_watch_normalize",
  complexity: "simple",
  speed: "moderate",
  reliability: "medium",
  sideEffects: "read-only",
};
const deps = {
  appContext: { repositories: { settings: { get: async () => null, set: async () => {} } } },
} as unknown as AppActionRuntimeDeps;

describe("connector_watch_normalize action", () => {
  it("throws when a read the event needs fails, so the routine retries it", async () => {
    // No Composio sign-in in tests: reading the Outlook message fails.
    await expect(
      createAction(config, deps).execute({
        source: "outlook",
        eventName: "provider:event:outlook.outlook_message_trigger",
        payload: { id: "AAMk1" },
        account: "me@contoso.com",
        kinds: ["new_mail"],
      }),
    ).rejects.toThrow("Rome is not signed in to Composio.");
  });

  it("answers an error, without throwing, for an event no adapter reads", async () => {
    expect(
      await createAction(config, deps).execute({
        source: "nowhere",
        eventName: "provider:event:nowhere.x",
        payload: {},
        account: "me",
        kinds: [],
      }),
    ).toEqual({
      status: "error",
      error: 'Rome cannot read provider:event:nowhere.x for "nowhere".',
    });
  });
});

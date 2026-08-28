import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionConfig, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";

import { createAction as createConnectorConnect } from "./connector-connect/index.js";
import { createAction as createConnectorEventSchema } from "./connector-event-schema/index.js";
import { createAction as createConnectorEventSearch } from "./connector-event-search/index.js";
import { createAction as createConnectorEventSubscribe } from "./connector-event-subscribe/index.js";
import { createAction as createConnectorLogin } from "./connector-login/index.js";
import { createAction as createConnectorProxy } from "./connector-proxy/index.js";
import { createAction as createConnectorSearch } from "./connector-search/index.js";
import { createAction as createConnectorToolExecute } from "./connector-tool-execute/index.js";
import { createAction as createConnectorToolSchema } from "./connector-tool-schema/index.js";

// The Composio credential lives in the CLI session (`$HOME/.composio/user_data.json`),
// read live via `readSessionApiKey`. Point HOME at a fresh empty dir so the
// fail-closed path ("not logged in") is exercised deterministically — independent
// of whether the machine running the tests happens to have a real Composio login.
//
// HOME is process-global, so this is only safe because each Rstest test FILE runs
// in its own isolated worker and the tests within a file run serially (no
// `.concurrent`) — nothing else in this process reads HOME while it is redirected.
// `rs.stubEnv` records the prior value and `rs.unstubAllEnvs` restores it even if
// an assertion throws mid-test, so the redirect can never leak past the file.
let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "connector-no-session-"));
  rs.stubEnv("HOME", homeDir);
});

afterEach(() => {
  rs.unstubAllEnvs();
  rmSync(homeDir, { recursive: true, force: true });
});

// The actions ignore their deps before the credential check, so a bare stub is
// enough to construct them.
const deps = {} as unknown as AppActionRuntimeDeps;

const config = (name: string): ActionConfig => ({
  name,
  type: "custom",
  description: name,
  complexity: "simple",
  speed: "fast",
  reliability: "medium",
  sideEffects: "read-only",
});

describe("connector actions when not logged in to Composio", () => {
  it("connector_search points the agent to connector_login instead of calling Composio", async () => {
    const action = createConnectorSearch(config("connector_search"), deps);
    const result = await action.execute({ query: "create a github issue" });
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringMatching(/connector_login/),
    });
  });

  it("connector_connect points the agent to connector_login instead of rendering its own card", async () => {
    // Sign-in is account-wide, so connector_connect must NOT render a login card:
    // two connects in one turn would otherwise stack two identical cards. It
    // returns a plain error naming connector_login (and the toolkit to retry),
    // so the duplicate can never appear. Uses a Composio-brokered toolkit (Notion),
    // since a Rome-managed one (github, slack) short-circuits before the sign-in check.
    const action = createConnectorConnect(config("connector_connect"), deps);
    const result = await action.execute({ toolkit: "notion" });
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringMatching(/connector_login/),
    });
    if (result.status !== "error") {
      throw new Error(`expected error, got ${result.status}`);
    }
    expect(result.error).toContain("notion");
  });

  it("connector_connect renders the unified card for GitHub, never a Composio connect", async () => {
    // GitHub is brokered by Rome's own integration (Rome Cloud OAuth); a Composio
    // connect here would create a second, unmanaged connection. The action must
    // short-circuit to the inline connect card — before the sign-in check, so it
    // never falls through to connector_login. It renders the single unified
    // `connect-card` (same componentId the Composio branch uses) with the github
    // toolkit; the card selects the Rome Cloud adapter from that prop and drives the
    // OAuth against core's /api/integrations.
    const action = createConnectorConnect(config("connector_connect"), deps);
    const result = await action.execute({ toolkit: "github" });
    expect(result).toMatchObject({
      status: "pending_interaction",
      interaction: {
        appId: "connector",
        // Cross-surface fallback: a messaging channel that can't mount the card
        // still gets the Settings → Connections hint as prose.
        promptText: expect.stringMatching(/settings/i),
        render: { kind: "inline", componentId: "connect-card", props: { toolkit: "github" } },
      },
    });
    if (result.status !== "pending_interaction") throw new Error(`got ${result.status}`);
    expect(result.interaction.promptText).not.toMatch(/connector_login/);
  });

  it("connector_connect refuses an unsupported toolkit and never renders a connect card", async () => {
    // connector_search exposes Composio's full catalog, so the agent can hand a
    // slug Rome can't broker (no managed auth config, e.g. twitter). The action
    // must reject it with a plain error — never a pending_interaction connect
    // card — and do so before the sign-in check, so it fails the same signed out.
    const action = createConnectorConnect(config("connector_connect"), deps);
    const result = await action.execute({ toolkit: "twitter" });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("twitter");
    expect(result.error).not.toMatch(/connector_login/);
  });

  it("connector_login renders the single inline sign-in card when not logged in", async () => {
    const action = createConnectorLogin(config("connector_login"), deps);
    const result = await action.execute({});
    expect(result).toMatchObject({
      status: "pending_interaction",
      interaction: {
        appId: "connector",
        // Required cross-surface fallback — a messaging channel that can't mount
        // the card still gets prose; assert it so a refactor can't silently drop it.
        promptText: expect.stringContaining("Composio"),
        // The login card is toolkit-independent: one account-wide sign-in, no
        // per-toolkit props that would make two connects render two cards.
        render: { kind: "inline", componentId: "login-card", props: {} },
      },
    });
  });

  it("connector_search rejects an empty query before any network call", async () => {
    const action = createConnectorSearch(config("connector_search"), deps);
    const result = await action.execute({});
    expect(result.status).toBe("error");
  });

  it("connector_search rejects a search scoped to an unsupported toolkit before any network call", async () => {
    // Scoping to a toolkit Rome can't OAuth into could only return tools the
    // owner can never authorize — reject with the same guidance connector_connect
    // gives, ahead of the sign-in check so it fails the same signed out.
    const action = createConnectorSearch(config("connector_search"), deps);
    const result = await action.execute({ query: "post a tweet", toolkit: "twitter" });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toContain("twitter");
    expect(result.error).not.toMatch(/connector_login/);
  });

  it("connector_connect rejects a missing toolkit before any network call", async () => {
    const action = createConnectorConnect(config("connector_connect"), deps);
    const result = await action.execute({});
    expect(result.status).toBe("error");
  });

  it("connector_tool_schema points the agent to connector_login instead of calling Composio", async () => {
    const action = createConnectorToolSchema(config("connector_tool_schema"), deps);
    const result = await action.execute({ toolkit: "gmail", slug: "GMAIL_SEND_EMAIL" });
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringMatching(/connector_login/),
    });
  });

  it("connector_tool_schema rejects a missing slug before any network call", async () => {
    const action = createConnectorToolSchema(config("connector_tool_schema"), deps);
    const result = await action.execute({ toolkit: "gmail" });
    expect(result.status).toBe("error");
  });

  it("connector_tool_execute points the agent to connector_login instead of calling Composio", async () => {
    const action = createConnectorToolExecute(config("connector_tool_execute"), deps);
    const result = await action.execute({ toolkit: "gmail", slug: "GMAIL_SEND_EMAIL", args: {} });
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringMatching(/connector_login/),
    });
  });

  it("connector_tool_execute rejects missing args before any network call", async () => {
    const action = createConnectorToolExecute(config("connector_tool_execute"), deps);
    const result = await action.execute({ toolkit: "gmail", slug: "GMAIL_SEND_EMAIL" });
    expect(result.status).toBe("error");
  });

  it("connector_proxy points the agent to connector_login instead of calling Composio", async () => {
    const action = createConnectorProxy(config("connector_proxy"), deps);
    const result = await action.execute({
      toolkit: "linear",
      path: "/graphql",
      method: "POST",
    });
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringMatching(/connector_login/),
    });
  });

  it("connector_proxy rejects a missing path before any network call", async () => {
    const action = createConnectorProxy(config("connector_proxy"), deps);
    const result = await action.execute({ toolkit: "linear", method: "POST" });
    expect(result.status).toBe("error");
  });

  it("connector_event_search points the agent to connector_login instead of calling Composio", async () => {
    const action = createConnectorEventSearch(config("connector_event_search"), deps);
    const result = await action.execute({ toolkit: "gmail" });
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringMatching(/connector_login/),
    });
  });

  it("connector_event_search rejects an invalid regex before any network call", async () => {
    // The regex is validated ahead of the credential check, so a malformed
    // pattern fails closed deterministically — even signed out.
    const action = createConnectorEventSearch(config("connector_event_search"), deps);
    const result = await action.execute({ toolkit: "gmail", regex: "[" });
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringMatching(/invalid regex/i),
    });
  });

  it("connector_event_search rejects a missing toolkit before any network call", async () => {
    const action = createConnectorEventSearch(config("connector_event_search"), deps);
    const result = await action.execute({});
    expect(result.status).toBe("error");
  });

  it("connector_event_schema points the agent to connector_login instead of calling Composio", async () => {
    const action = createConnectorEventSchema(config("connector_event_schema"), deps);
    const result = await action.execute({ toolkit: "gmail", slug: "GMAIL_NEW_GMAIL_MESSAGE" });
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringMatching(/connector_login/),
    });
  });

  it("connector_event_schema rejects a missing slug before any network call", async () => {
    const action = createConnectorEventSchema(config("connector_event_schema"), deps);
    const result = await action.execute({ toolkit: "gmail" });
    expect(result.status).toBe("error");
  });

  it("connector_event_subscribe points the agent to connector_login instead of calling Composio", async () => {
    const action = createConnectorEventSubscribe(config("connector_event_subscribe"), deps);
    const result = await action.execute({
      toolkit: "gmail",
      slug: "GMAIL_NEW_GMAIL_MESSAGE",
      config: {},
    });
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringMatching(/connector_login/),
    });
  });

  it("connector_event_subscribe rejects a missing config before any network call", async () => {
    // config is required (pass {} when none is needed) so the agent must have
    // consulted connector_event_schema rather than silently subscribing blind.
    const action = createConnectorEventSubscribe(config("connector_event_subscribe"), deps);
    const result = await action.execute({ toolkit: "gmail", slug: "GMAIL_NEW_GMAIL_MESSAGE" });
    expect(result.status).toBe("error");
  });
});

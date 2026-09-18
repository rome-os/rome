import { describe, expect, it, rs } from "@rstest/core";
import { SlackApiError, SlackIngress, type SlackEventEnvelope } from "../../channels/slack.js";
import type { GrantLedger } from "../ledger.js";
import type { SetupContext, SetupInteraction, SetupView } from "../setup/types.js";
import { CredentialRejected } from "../errors.js";
import {
  lockUnlinkedSlackTalk,
  makeSlackDescriptor,
  makeSlackSetup,
  missingSlackBotScopes,
} from "./slack.js";

const identity = {
  teamId: "T1",
  workspaceName: "Acme",
  botUserId: "UBOT",
  botUsername: "Rome",
};

function guardianCodeEvent(code: string): SlackEventEnvelope {
  return {
    type: "event_callback",
    event_id: `Ev-${code}`,
    team_id: "T1",
    event: {
      type: "message",
      channel_type: "im",
      channel: "D1",
      user: "UGUARDIAN",
      text: code,
      ts: "1700000000.1",
    },
  };
}

describe("Slack setup", () => {
  it("does not expose Talk for a connector-only grant when bot ingress is unconfigured", () => {
    const descriptor = makeSlackDescriptor({
      ingress: new SlackIngress(undefined),
      beginRedirect: async () => "unused",
      redeem: async () => {
        throw new Error("unused");
      },
    });

    expect(descriptor.capabilities.talker).toBeUndefined();
  });

  it("keeps a workspace retryable across a transient startup backoff", async () => {
    const ingress = new SlackIngress("secret", { startupGraceMs: 0 });
    ingress.completeInitialRegistration();
    const descriptor = makeSlackDescriptor({
      ingress,
      beginRedirect: async () => "unused",
      redeem: async () => {
        throw new Error("unused");
      },
      api: {
        authTest: async () => {
          throw new Error("temporary network failure");
        },
        postMessage: async () => ({ ts: "unused" }),
      },
    });
    const talker = descriptor.capabilities.talker?.build(
      { workspace: { material: { botToken: "xoxb-test" }, expiresAt: "never" } },
      {
        connectionId: "slack-connection",
        persist: async () => {},
        profile: () => ({ teamId: "T1", guardianLinked: true }),
        registerIngress: () => () => {},
      },
    );
    if (!talker) throw new Error("Slack Talk capability was not built");
    const fault = rs.fn();
    talker.start(() => {}, fault);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fault).toHaveBeenCalledWith(expect.objectContaining({ name: "Disconnected" }));

    talker.stop();

    await expect(ingress.dispatch(guardianCodeEvent("during-backoff"))).resolves.toBe("starting");
  });

  it("releases a healthy workspace immediately when its epoch is stopped", async () => {
    const ingress = new SlackIngress("secret", { startupGraceMs: 0 });
    ingress.completeInitialRegistration();
    const descriptor = makeSlackDescriptor({
      ingress,
      beginRedirect: async () => "unused",
      redeem: async () => {
        throw new Error("unused");
      },
      api: {
        authTest: async () => identity,
        postMessage: async () => ({ ts: "unused" }),
      },
    });
    const talker = descriptor.capabilities.talker?.build(
      { workspace: { material: { botToken: "xoxb-test" }, expiresAt: "never" } },
      {
        connectionId: "slack-connection",
        persist: async () => {},
        profile: () => ({ teamId: "T1", guardianLinked: true }),
        registerIngress: () => () => {},
      },
    );
    if (!talker) throw new Error("Slack Talk capability was not built");
    talker.start(
      () => {},
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    talker.stop();

    await expect(ingress.dispatch(guardianCodeEvent("after-stop"))).resolves.toBe("unhandled");
  });

  it("requires the exact least-privilege bot scopes", () => {
    expect(missingSlackBotScopes(["chat:write"])).toEqual(["app_mentions:read", "im:history"]);
    expect(missingSlackBotScopes(["im:history", "chat:write", "app_mentions:read"])).toEqual([]);
    expect(missingSlackBotScopes(undefined)).toEqual([]);
  });

  it("stays pending until the guardian DMs the one-time code", async () => {
    const ingress = new SlackIngress("secret");
    const views: SetupView[] = [];
    const controller = new AbortController();
    const interaction: SetupInteraction = {
      prompt: async () => ({}),
      redirect: async () => ({ handoff: "handoff", state: "state" }),
      show: (view) => views.push(view),
    };
    const context: SetupContext = {
      signal: controller.signal,
      step: (_label, fn) => fn(controller.signal),
    };
    const setup = makeSlackSetup({
      ingress,
      beginRedirect: async () => "https://cloud.example/oauth?state=state",
      redeem: async () => ({
        credential: { material: { botToken: "xoxb-test" }, expiresAt: "never" },
        profile: {
          teamId: "T1",
          workspaceName: "OAuth Acme",
          botUsername: "OAuth Rome",
          scopes: ["app_mentions:read", "chat:write", "im:history"],
        },
      }),
      api: {
        authTest: async () => ({ teamId: "T1", botUserId: "UBOT" }),
        postMessage: async () => ({ ts: "unused" }),
      },
      generateVerificationCode: () => "123456",
    });

    let settled = false;
    const conferralPromise = setup(interaction, context).then((value) => {
      settled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(views.at(-1)?.body).toContain("123456");

    const liveTalkHandler = rs.fn(() => {});
    ingress.subscribe(identity.teamId, liveTalkHandler);

    await ingress.dispatch(guardianCodeEvent("wrong"));
    expect(settled).toBe(false);
    await ingress.dispatch(guardianCodeEvent("123456"));

    const conferral = await conferralPromise;
    expect(conferral).toMatchObject({
      credential: {
        material: { botToken: "xoxb-test" },
      },
      guardianChannelUserId: "T1/UGUARDIAN",
      profile: {
        teamId: "T1",
        workspaceName: "OAuth Acme",
        botUserId: "UBOT",
        botUsername: "OAuth Rome",
        guardianLinked: true,
      },
    });
    expect(conferral.profile).not.toHaveProperty("guardianChannelUserId");
    expect(liveTalkHandler).toHaveBeenCalledTimes(1);
    expect(liveTalkHandler).toHaveBeenCalledWith(guardianCodeEvent("wrong"));
  });

  it("locks an imported workspace grant that has no guardian proof", async () => {
    const updateGrant = rs.fn(async () => {});
    const clearCustody = rs.fn(async () => {});
    const ledger = {
      listConnections: async () => [
        { id: "slack-connection", service: "slack", label: "Slack", createdAt: new Date() },
        { id: "github-connection", service: "github", label: "GitHub", createdAt: new Date() },
      ],
      getGrant: async () => ({
        custody: "slack-connection",
        name: "workspace",
        state: "authorized",
        credential: {
          material: { kind: "inline", record: { botToken: "xoxb-test" } },
          expiresAt: "never",
        },
      }),
      updateGrant,
    } as unknown as GrantLedger;
    const now = new Date("2026-09-18T00:00:00Z");

    await lockUnlinkedSlackTalk(ledger, { now, clearCustody });

    expect(updateGrant).toHaveBeenCalledExactlyOnceWith("slack-connection", "workspace", {
      state: "degraded",
      degraded: {
        at: now,
        reason: "Reconnect Slack in Settings to link the guardian identity.",
      },
    });
    expect(clearCustody).toHaveBeenCalledTimes(1);
  });

  it("restores only migration-locked connector grants when bot events are disabled", async () => {
    const listConnections = rs.fn(async () => [
      { id: "migration-locked", service: "slack", label: "Slack", createdAt: new Date() },
      { id: "other-fault", service: "slack", label: "Slack", createdAt: new Date() },
    ]);
    const updateGrant = rs.fn(async () => {});
    const clearCustody = rs.fn(async () => {});
    const ledger = {
      listConnections,
      getGrant: async (connectionId: string) => ({
        state: "degraded",
        degraded: {
          at: new Date(),
          reason:
            connectionId === "migration-locked"
              ? "Reconnect Slack in Settings to link the guardian identity."
              : "token revoked",
        },
      }),
      updateGrant,
    } as unknown as GrantLedger;

    await lockUnlinkedSlackTalk(ledger, {
      enabled: false,
      clearCustody,
    });

    expect(listConnections).toHaveBeenCalledTimes(1);
    expect(updateGrant).toHaveBeenCalledExactlyOnceWith("migration-locked", "workspace", {
      state: "authorized",
      degraded: undefined,
    });
    expect(clearCustody).not.toHaveBeenCalled();
  });

  it("keeps a guardian-linked workspace grant authorized", async () => {
    const updateGrant = rs.fn(async () => {});
    const clearCustody = rs.fn(async () => {});
    const ledger = {
      listConnections: async () => [
        { id: "slack-connection", service: "slack", label: "Slack", createdAt: new Date() },
      ],
      getGrant: async () => ({
        custody: "slack-connection",
        name: "workspace",
        state: "authorized",
        credential: {
          material: { kind: "inline", record: { botToken: "xoxb-test" } },
          expiresAt: "never",
        },
        profile: { guardianLinked: true },
      }),
      updateGrant,
    } as unknown as GrantLedger;

    await lockUnlinkedSlackTalk(ledger, { clearCustody });

    expect(updateGrant).not.toHaveBeenCalled();
    expect(clearCustody).not.toHaveBeenCalled();
  });

  it("reports an unlinked legacy Talk grant as a runtime fault without throwing at build", () => {
    const descriptor = makeSlackDescriptor({
      ingress: new SlackIngress("secret"),
      beginRedirect: async () => "unused",
      redeem: async () => {
        throw new Error("unused");
      },
    });

    const talker = descriptor.capabilities.talker?.build(
      { workspace: { material: { botToken: "xoxb-test" }, expiresAt: "never" } },
      {
        connectionId: "slack-connection",
        persist: async () => {},
        profile: () => undefined,
        registerIngress: () => () => {},
      },
    );
    if (!talker) throw new Error("Slack Talk capability was not built");
    const fault = rs.fn();

    expect(() => talker.start(() => {}, fault)).not.toThrow();
    expect(fault).toHaveBeenCalledExactlyOnceWith(expect.any(CredentialRejected));
  });

  it("refuses a grant without mention and DM permissions", async () => {
    const ingress = new SlackIngress("secret");
    const setup = makeSlackSetup({
      ingress,
      beginRedirect: async () => "https://cloud.example/oauth?state=state",
      redeem: async () => ({
        credential: { material: { botToken: "xoxb-test" }, expiresAt: "never" },
        profile: { teamId: "T1", scopes: ["chat:write"] },
      }),
      api: {
        authTest: async () => identity,
        postMessage: async () => ({ ts: "unused" }),
      },
    });
    const controller = new AbortController();

    await expect(
      setup(
        {
          prompt: async () => ({}),
          redirect: async () => ({ handoff: "handoff", state: "state" }),
          show: () => {},
        },
        {
          signal: controller.signal,
          step: (_label, fn) => fn(controller.signal),
        },
      ),
    ).rejects.toThrow("app_mentions:read, im:history");
  });

  it("refuses OAuth and bot tokens from different Slack applications", async () => {
    const setup = makeSlackSetup({
      ingress: new SlackIngress("secret"),
      beginRedirect: async () => "https://cloud.example/oauth?state=state",
      redeem: async () => ({
        credential: { material: { botToken: "xoxb-test" }, expiresAt: "never" },
        profile: {
          teamId: "T1",
          appId: "A-OAUTH",
          scopes: ["app_mentions:read", "chat:write", "im:history"],
        },
      }),
      api: {
        authTest: async () => ({ ...identity, appId: "A-TOKEN" }),
        postMessage: async () => ({ ts: "unused" }),
      },
    });
    const controller = new AbortController();

    await expect(
      setup(
        {
          prompt: async () => ({}),
          redirect: async () => ({ handoff: "handoff", state: "state" }),
          show: () => {},
        },
        {
          signal: controller.signal,
          step: (_label, fn) => fn(controller.signal),
        },
      ),
    ).rejects.toThrow("different application");
  });

  it("maps a revoked bot token to a workspace credential rejection", async () => {
    const ingress = new SlackIngress("secret");
    const descriptor = makeSlackDescriptor({
      ingress,
      beginRedirect: async () => "unused",
      redeem: async () => {
        throw new Error("unused");
      },
      api: {
        authTest: async () => identity,
        postMessage: async () => {
          throw new SlackApiError("token_revoked");
        },
      },
    });
    const talker = descriptor.capabilities.talker?.build(
      {
        workspace: {
          material: { botToken: "xoxb-test" },
          expiresAt: "never",
        },
      },
      {
        connectionId: "slack-connection",
        persist: async () => {},
        profile: () => ({ guardianLinked: true }),
        registerIngress: () => () => {},
      },
    );
    expect(talker).toBeDefined();
    if (!talker) throw new Error("Slack Talk capability was not built");

    talker.start(
      () => {},
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(talker.send("D1" as never, { text: "hello" })).rejects.toMatchObject({
      name: "CredentialRejected",
      grant: "workspace",
    });
  });

  it("faults on uninstall or bot-token revocation but not user-token revocation", async () => {
    const ingress = new SlackIngress("secret");
    const descriptor = makeSlackDescriptor({
      ingress,
      beginRedirect: async () => "unused",
      redeem: async () => {
        throw new Error("unused");
      },
      api: {
        authTest: async () => identity,
        postMessage: async () => ({ ts: "unused" }),
      },
    });
    const talker = descriptor.capabilities.talker?.build(
      {
        workspace: {
          material: { botToken: "xoxb-test" },
          expiresAt: "never",
        },
      },
      {
        connectionId: "slack-connection",
        persist: async () => {},
        profile: () => ({ guardianLinked: true }),
        registerIngress: () => () => {},
      },
    );
    if (!talker) throw new Error("Slack Talk capability was not built");
    const faults: unknown[] = [];
    talker.start(
      () => {},
      (fault) => faults.push(fault),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    await ingress.dispatch({
      type: "event_callback",
      event_id: "Ev-user-revoked",
      team_id: identity.teamId,
      event: { type: "tokens_revoked", tokens: { oauth: ["UINSTALLER"] } },
    });
    expect(faults).toHaveLength(0);

    await ingress.dispatch({
      type: "event_callback",
      event_id: "Ev-other-bot-revoked",
      team_id: identity.teamId,
      event: { type: "tokens_revoked", tokens: { bot: ["UOTHERBOT"] } },
    });
    expect(faults).toHaveLength(0);

    await ingress.dispatch({
      type: "event_callback",
      event_id: "Ev-bot-revoked",
      team_id: identity.teamId,
      event: { type: "tokens_revoked", tokens: { bot: ["UBOT"] } },
    });
    expect(faults).toHaveLength(1);
    expect(faults[0]).toBeInstanceOf(CredentialRejected);

    await ingress.dispatch({
      type: "event_callback",
      event_id: "Ev-uninstalled",
      team_id: identity.teamId,
      event: { type: "app_uninstalled" },
    });

    expect(faults).toHaveLength(2);
    expect(faults[1]).toBeInstanceOf(CredentialRejected);
    expect(faults[1]).toMatchObject({ grant: "workspace" });
  });
});

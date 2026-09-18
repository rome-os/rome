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
  it("reports the bot event prerequisite through descriptor availability", () => {
    const descriptor = makeSlackDescriptor({
      ingress: new SlackIngress(undefined),
      beginRedirect: async () => "unused",
      redeem: async () => {
        throw new Error("unused");
      },
    });

    expect(descriptor.connectAvailability?.()).toEqual({
      available: false,
      unavailableReason: "Slack bot events are not configured on this Rome instance.",
    });
  });

  it("requires the exact least-privilege bot scopes", () => {
    expect(missingSlackBotScopes(["chat:write"])).toEqual(["app_mentions:read", "im:history"]);
    expect(missingSlackBotScopes(["im:history", "chat:write", "app_mentions:read"])).toEqual([]);
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

    await expect(conferralPromise).resolves.toMatchObject({
      credential: {
        material: { botToken: "xoxb-test" },
      },
      guardianChannelUserId: "T1/UGUARDIAN",
      profile: {
        teamId: "T1",
        workspaceName: "OAuth Acme",
        botUserId: "UBOT",
        botUsername: "OAuth Rome",
      },
    });
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
        profile: { guardianChannelUserId: "T1/UGUARDIAN" },
      }),
      updateGrant,
    } as unknown as GrantLedger;

    await lockUnlinkedSlackTalk(ledger, { clearCustody });

    expect(updateGrant).not.toHaveBeenCalled();
    expect(clearCustody).not.toHaveBeenCalled();
  });

  it("refuses to build Talk without the guardian-link marker", () => {
    const descriptor = makeSlackDescriptor({
      ingress: new SlackIngress("secret"),
      beginRedirect: async () => "unused",
      redeem: async () => {
        throw new Error("unused");
      },
    });

    expect(() =>
      descriptor.capabilities.talker?.build(
        { workspace: { material: { botToken: "xoxb-test" }, expiresAt: "never" } },
        {
          connectionId: "slack-connection",
          persist: async () => {},
          profile: () => undefined,
          registerIngress: () => () => {},
        },
      ),
    ).toThrow("Reconnect Slack in Settings");
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
        profile: () => ({ guardianChannelUserId: "T1/UGUARDIAN" }),
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

  it("reports a Slack uninstall as a workspace credential fault", async () => {
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
        profile: () => ({ guardianChannelUserId: "T1/UGUARDIAN" }),
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
      event_id: "Ev-uninstalled",
      team_id: identity.teamId,
      event: { type: "app_uninstalled" },
    });

    expect(faults).toHaveLength(1);
    expect(faults[0]).toBeInstanceOf(CredentialRejected);
    expect(faults[0]).toMatchObject({ grant: "workspace" });
  });
});

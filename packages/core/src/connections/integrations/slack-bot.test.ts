import { describe, expect, it, rs } from "@rstest/core";
import {
  type CreateSlackSocket,
  SlackApiError,
  type SlackSocketLike,
  type SlackWebApi,
} from "../../channels/slack.js";
import { CredentialRejected } from "../errors.js";
import { SetupSession } from "../setup/session.js";
import type { SetupConferral, SetupState } from "../setup/types.js";
import {
  makeSlackBotDescriptor,
  makeSlackBotSetup,
  slackBotAccountId,
  slackBotDisplayName,
  slackBotManifest,
  slackCreateAppUrl,
  toSlackBotDisplay,
} from "./slack-bot.js";

function fakeApi(overrides: Partial<SlackWebApi> = {}): SlackWebApi {
  return {
    authTest: rs.fn(async () => ({
      teamId: "T1",
      workspaceName: "Acme",
      botUserId: "UBOT",
      botUsername: "scout",
      appId: "A1",
    })),
    openConnection: rs.fn(async () => "wss://example.invalid/socket"),
    postMessage: rs.fn(async () => ({ ts: "1.0" })),
    openDirectMessage: rs.fn(async () => "D1"),
    userName: rs.fn(async () => ({})),
    ...overrides,
  };
}

/** A Socket Mode connection that says hello as `appId`. */
function helloAs(appId: string): CreateSlackSocket {
  return () => {
    const listeners: Array<(event: { data: unknown }) => void> = [];
    const socket = {
      send: () => {},
      close: () => {},
      ping: () => {},
      addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
        if (type === "message") listeners.push(listener);
      },
    } as unknown as SlackSocketLike;
    setTimeout(() => {
      const data = JSON.stringify({ type: "hello", connection_info: { app_id: appId } });
      for (const listener of listeners) listener({ data });
    }, 0);
    return socket;
  };
}

function formOf(state: SetupState) {
  if (state.status !== "awaiting-input") throw new Error(`setup is ${state.status}`);
  return state;
}

describe("slack bot manifest", () => {
  it("turns on Socket Mode, asks only for DM and mention scopes, and carries no request URL", () => {
    const manifest = slackBotManifest("Scout") as {
      display_information: { name: string };
      features: { bot_user: { display_name: string } };
      oauth_config: { scopes: { bot: string[] } };
      settings: {
        socket_mode_enabled: boolean;
        event_subscriptions: { bot_events: string[]; request_url?: string };
      };
    };
    expect(manifest.display_information.name).toBe("Scout");
    expect(manifest.features.bot_user.display_name).toBe("scout");
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.settings.event_subscriptions.request_url).toBeUndefined();
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(
      expect.arrayContaining(["app_mention", "message.im"]),
    );
    expect(manifest.oauth_config.scopes.bot).not.toContain("channels:history");
  });

  it("links to Slack's create-app flow with the manifest prefilled", () => {
    const url = new URL(slackCreateAppUrl("Scout"));
    expect(url.origin).toBe("https://api.slack.com");
    expect(url.searchParams.get("new_app")).toBe("1");
    expect(JSON.parse(url.searchParams.get("manifest_json")!)).toEqual(slackBotManifest("Scout"));
  });

  it("derives a display name Slack accepts", () => {
    expect(slackBotDisplayName("Research Bot!")).toBe("research-bot");
    expect(slackBotDisplayName("!!!")).toBe("rome");
  });

  it("tells two bots in one workspace apart by name", () => {
    const scout = toSlackBotDisplay({
      teamId: "T1",
      botUserId: "U1",
      botUsername: "scout",
      workspaceName: "Acme",
    });
    const scribe = toSlackBotDisplay({
      teamId: "T1",
      botUserId: "U2",
      botUsername: "scribe",
      workspaceName: "Acme",
    });
    expect(scout.displayName).toBe("scout (Acme)");
    expect(scribe.displayName).toBe("scribe (Acme)");
    expect(scout.handle).toBe("@scout");
  });

  it("names an account by its workspace and bot user", () => {
    expect(slackBotAccountId({ teamId: "T1", botUserId: "UBOT" })).toBe("T1/UBOT");
    expect(slackBotAccountId({ teamId: "T1" })).toBeNull();
  });
});

describe("slack bot setup", () => {
  it("asks for a name, links the prefilled app, and confers both checked tokens", async () => {
    const api = fakeApi();
    const commit = rs.fn(async (_value: SetupConferral) => {});
    const session = new SetupSession({
      fn: makeSlackBotSetup({ api, createSocket: helloAs("A1") }),
      commit,
    });
    await session.started();
    expect(formOf(session.state).form.fields.map((field) => field.name)).toEqual(["name"]);

    await session.provideInput({ name: "Scout" });
    await rs.waitFor(() => expect(formOf(session.state).form.fields).toHaveLength(2));
    const link = formOf(session.state).form.links?.[0];
    expect(link?.url).toBe(slackCreateAppUrl("Scout"));

    await session.provideInput({ botToken: " xoxb-1 ", appToken: "xapp-1" });
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    expect(api.authTest).toHaveBeenCalledWith("xoxb-1", expect.anything());
    expect(api.openConnection).toHaveBeenCalledWith("xapp-1", expect.anything());
    expect(commit.mock.calls[0][0]).toMatchObject({
      credential: { material: { botToken: "xoxb-1", appToken: "xapp-1" }, expiresAt: "never" },
      profile: { teamId: "T1", botUserId: "UBOT", botUsername: "scout", workspaceName: "Acme" },
    });
    expect(commit.mock.calls[0][0]).not.toHaveProperty("guardianChannelUserId");
  });

  it("renews from the existing app's tokens without offering a new app", async () => {
    const commit = rs.fn(async (_value: SetupConferral) => {});
    const session = new SetupSession({
      fn: makeSlackBotSetup({ api: fakeApi(), createSocket: helloAs("A1") }),
      commit,
      renewing: true,
    });
    await session.started();
    const form = formOf(session.state).form;
    expect(form.fields.map((field) => field.name)).toEqual(["botToken", "appToken"]);
    expect(form.links?.map((link) => link.url)).toEqual(["https://api.slack.com/apps"]);

    await session.provideInput({ botToken: "xoxb-2", appToken: "xapp-2" });
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    expect(commit.mock.calls[0][0]).toMatchObject({
      credential: { material: { botToken: "xoxb-2", appToken: "xapp-2" } },
      profile: { teamId: "T1", botUserId: "UBOT" },
    });
  });

  it("re-prompts a name Slack would refuse", async () => {
    const commit = rs.fn(async (_value: SetupConferral) => {});
    const session = new SetupSession({
      fn: makeSlackBotSetup({ api: fakeApi(), createSocket: helloAs("A1") }),
      commit,
    });
    await session.started();
    await session.provideInput({ name: "x".repeat(36) });
    await rs.waitFor(() => expect(formOf(session.state).error).toMatch(/35 characters/));
    expect(formOf(session.state).form.fields.map((field) => field.name)).toEqual(["name"]);
  });

  it("re-prompts swapped tokens without calling Slack", async () => {
    const api = fakeApi();
    const commit = rs.fn(async (_value: SetupConferral) => {});
    const session = new SetupSession({
      fn: makeSlackBotSetup({ api, createSocket: helloAs("A1") }),
      commit,
    });
    await session.started();
    await session.provideInput({ name: "Scout" });
    await rs.waitFor(() => expect(formOf(session.state).form.fields).toHaveLength(2));
    await session.provideInput({ botToken: "xapp-1", appToken: "xoxb-1" });
    await rs.waitFor(() => expect(formOf(session.state).error).toMatch(/xoxb-/));
    expect(api.authTest).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("re-prompts two valid tokens from different apps", async () => {
    const commit = rs.fn(async (_value: SetupConferral) => {});
    const session = new SetupSession({
      fn: makeSlackBotSetup({ api: fakeApi(), createSocket: helloAs("A2") }),
      commit,
    });
    await session.started();
    await session.provideInput({ name: "Scout" });
    await rs.waitFor(() => expect(formOf(session.state).form.fields).toHaveLength(2));
    await session.provideInput({ botToken: "xoxb-1", appToken: "xapp-other" });
    await rs.waitFor(() => expect(formOf(session.state).error).toMatch(/different Slack apps/));
    expect(commit).not.toHaveBeenCalled();
  });

  it("re-prompts an app-level token Slack refuses, and connects on retry", async () => {
    let refuse = true;
    const api = fakeApi({
      openConnection: rs.fn(async () => {
        if (refuse) throw new Error("invalid_auth");
        return "wss://example.invalid/socket";
      }),
    });
    const commit = rs.fn(async (_value: SetupConferral) => {});
    const session = new SetupSession({
      fn: makeSlackBotSetup({ api, createSocket: helloAs("A1") }),
      commit,
    });
    await session.started();
    await session.provideInput({ name: "Scout" });
    await rs.waitFor(() => expect(formOf(session.state).form.fields).toHaveLength(2));
    await session.provideInput({ botToken: "xoxb-1", appToken: "xapp-bad" });
    await rs.waitFor(() => expect(formOf(session.state).error).toMatch(/app-level token/));
    expect(commit).not.toHaveBeenCalled();

    refuse = false;
    await session.provideInput({ botToken: "xoxb-1", appToken: "xapp-good" });
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    expect(commit).toHaveBeenCalledTimes(1);
  });
});

describe("slack bot talker", () => {
  it("reports a bot token Slack refuses while opening a DM as a refused credential", async () => {
    const api = fakeApi({
      openDirectMessage: rs.fn(async () => {
        throw new SlackApiError("invalid_auth");
      }),
    });
    const descriptor = makeSlackBotDescriptor({ api, createSocket: helloAs("A1") });
    const talker = descriptor.capabilities.talker!.build(
      { bot: { material: { botToken: "xoxb-1", appToken: "xapp-1" }, expiresAt: "never" } },
      { connectionId: "conn-1", persist: async () => {}, registerIngress: () => () => {} },
    );
    talker.start(
      () => {},
      () => {},
    );
    await rs.waitFor(() => expect(api.openConnection).toHaveBeenCalled());
    await expect(talker.directMessaging!.chatFor("T1/UADA")).rejects.toBeInstanceOf(
      CredentialRejected,
    );
    await talker.stop();
  });
});

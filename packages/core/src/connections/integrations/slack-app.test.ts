import { describe, expect, it, rs } from "@rstest/core";
import { CredentialRejected } from "../errors.js";
import { SlackApiError } from "../kinds/slack/slack.js";
import type { SlackAppCloud, SlackAppInstall } from "../kinds/slack-app/rome-cloud.js";
import { SlackAppRefused } from "../kinds/slack-app/rome-cloud.js";
import { createSlackAppWebApi } from "../kinds/slack-app/web-api.js";
import type { SetupForm, SetupInteraction } from "../setup/types.js";
import {
  fencedCloud,
  makeSlackAppDescriptor,
  makeSlackAppSetup,
  slackAppAccountId,
} from "./slack-app.js";

const INSTALL: SlackAppInstall = {
  teamId: "T_A",
  teamName: "Acme",
  botUserId: "U_BOT",
  botToken: "xoxb-a",
  appId: "A_ROME",
  installerUserId: "U_GUARDIAN",
  scopes: ["chat:write"],
  mailbox: { connectUrl: "wss://relay.test/c/mbx", drainKey: "k" },
  forwardSecret: "secret",
};

const ctx = {
  step: <T>(_label: string, fn: (signal: AbortSignal) => Promise<T>) =>
    fn(new AbortController().signal),
  signal: new AbortController().signal,
};

function cloud(overrides: Partial<SlackAppCloud> = {}): SlackAppCloud {
  return {
    start: rs.fn(async () => "https://fake-slack.test/oauth/v2/authorize?state=s"),
    redeem: rs.fn(async () => INSTALL),
    refreshMailbox: rs.fn(async () => INSTALL.mailbox),
    release: rs.fn(async () => {}),
    ...overrides,
  };
}

function interaction(returned: Record<string, string>) {
  const prompts: SetupForm[] = [];
  const redirects: string[] = [];
  const interact: SetupInteraction = {
    prompt: async (form) => {
      prompts.push(form);
      return {};
    },
    show: () => {},
    redirect: async (url) => {
      redirects.push(url);
      return returned;
    },
  };
  return { interact, prompts, redirects };
}

describe("connecting Rome's Slack app (R1)", () => {
  it("goes from Connect through Slack's approve screen to a grant with no form", async () => {
    const c = cloud();
    const { interact, prompts, redirects } = interaction({ handoff: "h", state: "s" });
    const grant = await makeSlackAppSetup({ cloud: c, instanceOrigin: () => "https://me.test" })(
      interact,
      ctx,
    );

    expect(prompts).toHaveLength(0);
    expect(redirects).toEqual(["https://fake-slack.test/oauth/v2/authorize?state=s"]);
    const started = (c.start as ReturnType<typeof rs.fn>).mock.calls[0][0] as {
      callbackOrigin: string;
      state: string;
      codeChallenge: string;
    };
    expect(started.callbackOrigin).toBe("https://me.test");
    expect(started.state).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(started.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const redeemed = (c.redeem as ReturnType<typeof rs.fn>).mock.calls[0][0] as {
      handoff: string;
      codeVerifier: string;
    };
    expect(redeemed.handoff).toBe("h");

    expect(grant.profile).toEqual({
      teamId: "T_A",
      workspaceName: "Acme",
      botUserId: "U_BOT",
      appId: "A_ROME",
      installerUserId: "U_GUARDIAN",
    });
    expect(grant.credential.material).toEqual({
      teamId: "T_A",
      botUserId: "U_BOT",
      botToken: "xoxb-a",
      forwardSecret: "secret",
      connectUrl: "wss://relay.test/c/mbx",
      drainKey: "k",
    });
    // The member who approved is the guardian there from their first message.
    expect(grant.guardianChannelUserId).toBe("T_A/U_GUARDIAN");
    expect(slackAppAccountId(grant.profile ?? {})).toBe("T_A/U_BOT");
  });

  it("names the account the way the Slack bot kind does, and holds one workspace", () => {
    const descriptor = makeSlackAppDescriptor({
      openToMembers: { isOpen: () => false, set: () => {} },
      api: {} as never,
      cloud: cloud(),
      openMailbox: () => ({ stop: () => {} }),
      copy: {} as never,
    });
    expect(descriptor.link).toBe("own_account");
    expect(descriptor.severalAccounts).toBeUndefined();
    expect(descriptor.accountIdOf?.({ teamId: "T_A", botUserId: "U_BOT" })).toBe("T_A/U_BOT");
  });

  it("tells the guardian when they declined on Slack", async () => {
    const { interact } = interaction({ error: "access_denied", state: "s" });
    await expect(makeSlackAppSetup({ cloud: cloud() })(interact, ctx)).rejects.toThrow(
      /was not added/,
    );
  });
});

describe("a workspace another Rome holds (R3)", () => {
  it("fails the setup with Rome Cloud's reason", async () => {
    const c = cloud({
      redeem: rs.fn(async () => {
        throw new SlackAppRefused(
          "workspace_bound",
          "This Slack workspace is already connected to another Rome.",
        );
      }),
    });
    const { interact } = interaction({ handoff: "h", state: "s" });
    await expect(
      makeSlackAppSetup({ cloud: c, instanceOrigin: () => "https://me.test" })(interact, ctx),
    ).rejects.toThrow("This Slack workspace is already connected to another Rome.");
  });
});

describe("the Slack app talker", () => {
  it("drains the stored mailbox, keeps a refreshed drain key, and sends as the bot", async () => {
    const opened: string[] = [];
    const persisted: Record<string, string>[] = [];
    const descriptor = makeSlackAppDescriptor({
      openToMembers: { isOpen: () => false, set: () => {} },
      api: {
        authTest: async () => ({ teamId: "T_A", botUserId: "U_BOT" }),
        postMessage: async () => ({ ts: "3.0" }),
        openDirectMessage: async () => "D1",
        userName: async () => ({}),
        conversationHistory: async () => ({ messages: [], hasMore: false }),
        conversationReplies: async () => ({ messages: [] }),
        memberChannels: async () => ({ channels: [] }),
        revoke: async () => {},
      },
      cloud: cloud({
        refreshMailbox: async () => ({ connectUrl: "wss://relay.test/c/mbx", drainKey: "fresh" }),
      }),
      openMailbox: (mailbox) => {
        opened.push(mailbox.drainKey);
        return { stop: () => {} };
      },
      copy: {
        keep: (kept) => kept.message,
        handedOver: () => {},
        mayNotHold: () => [],
        keepRun: () => [],
        timelineRow: () => null,
        timelineBefore: () => [],
        timelineAfter: () => null,
        holdsNewer: () => false,
        unlinkAcross: () => {},
        change: () => true,
        deleted: () => false,
        search: () => [],
      },
    });
    const talker = descriptor.capabilities.talker?.build(
      {
        material: {
          teamId: "T_A",
          botUserId: "U_BOT",
          botToken: "xoxb-a",
          forwardSecret: "secret",
          connectUrl: "wss://relay.test/c/mbx",
          drainKey: "old",
          generation: "4",
        },
        expiresAt: "never",
      },
      {
        connectionId: "c1",
        persist: async (material) => {
          persisted.push(material);
        },
        registerIngress: () => () => {},
      },
    );
    const faults: unknown[] = [];
    talker?.start(
      () => {},
      (fault) => faults.push(fault),
    );
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(faults).toEqual([]);
    expect(opened).toEqual(["fresh"]);
    expect(persisted[0]?.drainKey).toBe("fresh");
    // The release still names the connect's claim after a refresh.
    expect(persisted[0]?.generation).toBe("4");
    expect(await talker?.send("D1" as never, { text: "hi" } as never)).toMatchObject({
      messageId: "3.0",
    });
    await talker?.stop();
  });
});

describe("the Slack app's channels in chat settings", () => {
  /** The talker of a connection whose channel listing Slack answers with
   *  `memberChannels`. */
  function channelTalker(
    memberChannels: () => Promise<{ channels: { id: string; name: string; isPrivate: boolean }[] }>,
  ) {
    const descriptor = makeSlackAppDescriptor({
      openToMembers: { isOpen: () => false, set: () => {} },
      api: {
        authTest: async () => ({ teamId: "T_A", botUserId: "U_BOT" }),
        postMessage: async () => ({ ts: "3.0" }),
        openDirectMessage: async () => "D1",
        userName: async () => ({}),
        conversationHistory: async () => ({ messages: [], hasMore: false }),
        conversationReplies: async () => ({ messages: [] }),
        memberChannels,
        revoke: async () => {},
      },
      cloud: cloud(),
      openMailbox: () => ({ stop: () => {} }),
      copy: {
        keep: (kept) => kept.message,
        handedOver: () => {},
        mayNotHold: () => [],
        keepRun: () => [],
        timelineRow: () => null,
        timelineBefore: () => [],
        timelineAfter: () => null,
        holdsNewer: () => false,
        search: () => [],
        unlinkAcross: () => {},
        change: () => true,
        deleted: () => false,
      },
    });
    const talker = descriptor.capabilities.talker?.build(
      {
        material: {
          teamId: "T_A",
          botUserId: "U_BOT",
          botToken: "xoxb-a",
          forwardSecret: "secret",
          connectUrl: "wss://relay.test/c/mbx",
          drainKey: "k",
        },
        expiresAt: "never",
      },
      { connectionId: "c1", persist: async () => {}, registerIngress: () => () => {} },
    );
    return talker;
  }

  it("lists the channels the app is a member of by name, and finds one by part of it", async () => {
    const talker = channelTalker(async () => ({
      channels: [
        { id: "C_NEWS", name: "news", isPrivate: false },
        { id: "G_OPS", name: "ops", isPrivate: true },
      ],
    }));

    const all = await talker?.directory?.listConversations({ limit: 10 });
    const found = await talker?.directory?.listConversations({ query: "#NE", limit: 10 });

    expect(all?.conversations.map((each) => each.displayName)).toEqual(["#news", "#ops"]);
    expect(found?.conversations).toEqual([
      {
        ref: { connectionId: "c1", chatId: "C_NEWS" },
        connectionKind: "slack_app",
        service: "slack_app",
        kind: "channel",
        displayName: "#news",
      },
    ]);
  });

  it("reports a token Slack refuses as a rejected credential", async () => {
    const talker = channelTalker(async () => {
      throw new SlackApiError("token_revoked");
    });

    await expect(talker?.directory?.listConversations({ limit: 10 })).rejects.toBeInstanceOf(
      CredentialRejected,
    );
  });
});

describe("disconnecting the Slack app in Rome (R8)", () => {
  const MATERIAL = {
    teamId: "T_A",
    botUserId: "U_BOT",
    botToken: "xoxb-a",
    forwardSecret: "secret",
    connectUrl: "wss://relay.test/c/mbx",
    drainKey: "k",
  };
  function descriptorWith(revoke: () => Promise<void>, c = cloud()) {
    const steps: string[] = [];
    const descriptor = makeSlackAppDescriptor({
      openToMembers: {
        isOpen: () => false,
        set: (account, open) => void steps.push(`${open ? "open" : "close"} ${account}`),
      },
      api: {
        authTest: async () => ({ teamId: "T_A", botUserId: "U_BOT" }),
        postMessage: async () => ({ ts: "1.0" }),
        openDirectMessage: async () => "D1",
        userName: async () => ({}),
        conversationHistory: async () => ({ messages: [], hasMore: false }),
        conversationReplies: async () => ({ messages: [] }),
        memberChannels: async () => ({ channels: [] }),
        revoke: async (token) => {
          steps.push(`revoke ${token}`);
          await revoke();
        },
      },
      cloud: {
        ...c,
        release: async (teamId, signal, generation) => {
          steps.push(`release ${teamId}`);
          await c.release(teamId, signal, generation);
        },
      },
      openMailbox: () => ({ stop: () => {} }),
      copy: {} as never,
    });
    return { descriptor, steps };
  }

  it("revokes the token at Slack, then releases the workspace at Rome Cloud", async () => {
    const { descriptor, steps } = descriptorWith(async () => {});
    await descriptor.onDisconnect?.(
      { material: MATERIAL, profile: {} },
      { signal: new AbortController().signal },
    );
    expect(steps).toEqual(["revoke xoxb-a", "release T_A"]);
  });

  it("says Slack kept the token, and releases nothing, when the revoke fails", async () => {
    const { descriptor, steps } = descriptorWith(async () => {
      throw new Error("Slack API returned HTTP 503");
    });
    await expect(
      descriptor.onDisconnect?.(
        { material: MATERIAL, profile: {} },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow("Slack did not revoke Rome's token (Slack API returned HTTP 503)");
    expect(steps).toEqual(["revoke xoxb-a"]);
  });

  it("holds off a connect until a release Rome stopped waiting for has ended", async () => {
    let finish = () => {};
    const steps: string[] = [];
    const fenced = fencedCloud(
      cloud({
        release: async () => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          steps.push("released");
        },
        redeem: async () => {
          steps.push("redeemed");
          return INSTALL;
        },
      }),
    );
    const stop = new AbortController();
    const releasing = fenced.release("T_A", stop.signal);
    stop.abort(new Error("no answer within 10s"));
    await expect(releasing).rejects.toThrow("no answer within 10s");

    const redeeming = fenced.redeem({ handoff: "h", codeVerifier: "v" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(steps).toEqual([]);
    finish();
    await redeeming;
    expect(steps).toEqual(["released", "redeemed"]);
  });

  it("releases nothing once the disconnect has stopped waiting", async () => {
    const stop = new AbortController();
    const { descriptor, steps } = descriptorWith(async () => {
      // Slack answers after the disconnect's limit.
      stop.abort();
    });
    await expect(
      descriptor.onDisconnect?.({ material: MATERIAL, profile: {} }, { signal: stop.signal }),
    ).rejects.toThrow("Rome stopped waiting before releasing the workspace");
    expect(steps).toEqual(["revoke xoxb-a"]);
  });

  it("names its connect's claim, so a release landing after a reconnect ends nothing", async () => {
    // Rome Cloud's rule: each connect takes a higher generation than the last, and a release
    // naming one ends that claim only.
    let bound: number | null = null;
    let claims = 0;
    const late: Array<() => void> = [];
    const c = cloud({
      redeem: async () => {
        bound = ++claims;
        return { ...INSTALL, generation: claims };
      },
      // The release reaches Rome Cloud, but Rome stops waiting before it
      // commits: it lands only later.
      release: async (_teamId, _signal, generation) => {
        late.push(() => {
          if (generation === undefined || generation === bound) bound = null;
        });
        throw new Error("Rome Cloud did not answer within 60s");
      },
    });
    const connect = async () =>
      (
        await makeSlackAppSetup({ cloud: c, instanceOrigin: () => "https://me.test" })(
          interaction({ handoff: "h", state: "s" }).interact,
          ctx,
        )
      ).credential.material as Record<string, string>;
    const first = await connect();
    const { descriptor } = descriptorWith(async () => {}, c);
    await expect(
      descriptor.onDisconnect?.(
        { material: first, profile: {} },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow("Rome Cloud did not release the workspace");

    const second = await connect();
    for (const land of late) land();

    expect(first).toMatchObject({ generation: "1" });
    expect(second).toMatchObject({ generation: "2" });
    expect(bound).toBe(2);
  });

  it("releases a claim a cancelled fix's redeem made while the disconnect ran", async () => {
    let bound: number | null = 1;
    let land = () => {};
    const c = cloud({
      // The fix's redeem is at Rome Cloud when the guardian disconnects: it
      // claims the workspace again only after the disconnect began.
      redeem: () =>
        new Promise((resolve) => {
          land = () => {
            bound = 2;
            resolve({ ...INSTALL, botToken: "xoxb-fix", generation: 2 });
          };
        }),
      release: async (_teamId, _signal, generation) => {
        if (generation === undefined || generation === bound) bound = null;
      },
    });
    const { descriptor, steps } = descriptorWith(async () => {}, c);
    const fixing = new AbortController();
    const setup = descriptor.auth.setup;
    if (!setup) throw new Error("no setup");
    const fix = setup(interaction({ handoff: "h", state: "s" }).interact, {
      ...ctx,
      signal: fixing.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixing.abort(new Error("cancelled by the disconnect"));

    const disconnecting = descriptor.onDisconnect?.(
      { material: { ...MATERIAL, generation: "1" }, profile: {} },
      { signal: new AbortController().signal },
    );
    land();
    await disconnecting;
    await fix.catch(() => {});

    expect(bound).toBeNull();
    // The fix's token, which no grant holds, is revoked as well.
    expect(steps).toEqual(["revoke xoxb-a", "revoke xoxb-fix", "release T_A"]);
  });

  it("releases with no generation a grant made before Rome Cloud counted claims", async () => {
    const release = rs.fn(async () => {});
    const { descriptor } = descriptorWith(async () => {}, cloud({ release }));
    await descriptor.onDisconnect?.(
      { material: MATERIAL, profile: {} },
      { signal: new AbortController().signal },
    );
    expect(release).toHaveBeenCalledWith("T_A", expect.anything(), undefined);
  });

  it("says Rome Cloud kept the workspace when the release fails", async () => {
    const c = cloud({
      release: rs.fn(async () => {
        throw new SlackAppRefused("unavailable", "Rome Cloud is unreachable");
      }),
    });
    const { descriptor } = descriptorWith(async () => {}, c);
    await expect(
      descriptor.onDisconnect?.(
        { material: MATERIAL, profile: {} },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow("Rome Cloud did not release the workspace");
  });

  it("counts a token Slack already refuses as revoked", async () => {
    const answers = ["invalid_auth", "token_revoked"];
    const api = createSlackAppWebApi("https://slack.test", async () =>
      Response.json({ ok: false, error: answers.shift() }),
    );
    await api.revoke("xoxb-dead");
    await api.revoke("xoxb-dead");
    const refusing = createSlackAppWebApi("https://slack.test", async () =>
      Response.json({ ok: false, error: "ratelimited" }),
    );
    await expect(refusing.revoke("xoxb-a")).rejects.toThrow();
  });
});

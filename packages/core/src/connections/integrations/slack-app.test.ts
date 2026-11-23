import { describe, expect, it, rs } from "@rstest/core";
import { CredentialRejected, Disconnected } from "../errors.js";
import { SlackApiError } from "../kinds/slack/slack.js";
import { depositSignature, SLACK_SIGNATURE_HEADER } from "../kinds/slack-app/deposit.js";
import type { SlackAppCloud, SlackAppWorkspace } from "../kinds/slack-app/rome-cloud.js";
import { SlackAppRefused } from "../kinds/slack-app/rome-cloud.js";
import { ROME_CLOUD_UNAVAILABLE, type SlackAppWebApi } from "../kinds/slack-app/web-api.js";
import type { SetupForm, SetupInteraction, SetupView } from "../setup/types.js";
import type { RuntimeKit } from "../types.js";
import {
  makeSlackAppDescriptor,
  makeSlackAppSetup,
  REAPPROVE_FOR_GATEWAY,
  type SlackAppDescriptorDeps,
  slackAppAccountId,
} from "./slack-app.js";

const DEPOSIT_URL = "https://ingest.test/h/mbx.sig";
const INSTALL_URL = "https://slack.com/oauth/v2/authorize?state=s";

const WORKSPACE: SlackAppWorkspace = {
  teamId: "T_A",
  teamName: "Acme",
  botUserId: "U_BOT",
  installerUserId: "U_GUARDIAN",
  boundAt: 2_000,
};

const ctx = {
  step: <T>(_label: string, fn: (signal: AbortSignal) => Promise<T>) =>
    fn(new AbortController().signal),
  signal: new AbortController().signal,
};

/** The Worker and Rome Cloud: `held` is what the Worker holds for this Rome,
 *  listed in turn by each call to `workspaces`, the last one from then on. */
function cloud(
  overrides: Partial<SlackAppCloud> = {},
  held: SlackAppWorkspace[][] = [[], [WORKSPACE]],
): SlackAppCloud {
  let listed = 0;
  return {
    connect: rs.fn(async () => ({ depositKey: "key-1", workspaces: held[0] ?? [] })),
    disconnect: rs.fn(async () => {}),
    workspaces: rs.fn(async () => held[Math.min(listed++, held.length - 1)] ?? []),
    installUrl: rs.fn(async () => INSTALL_URL),
    ...overrides,
  };
}

function interaction() {
  const prompts: SetupForm[] = [];
  const redirects: string[] = [];
  const shown: SetupView[] = [];
  const interact: SetupInteraction = {
    prompt: async (form) => {
      prompts.push(form);
      return {};
    },
    show: (view) => {
      shown.push(view);
    },
    redirect: async (url) => {
      redirects.push(url);
      return {};
    },
  };
  return { interact, prompts, redirects, shown };
}

const fast = { pollMs: 1, limitMs: 1_000 };

function setup(c: SlackAppCloud, depositUrl: string | null = DEPOSIT_URL) {
  return makeSlackAppSetup({ cloud: c, depositUrl: async () => depositUrl, approval: fast });
}

function fakeApi(overrides: Partial<SlackAppWebApi> = {}): SlackAppWebApi {
  return {
    postMessage: async () => ({ ts: "3.0" }),
    openDirectMessage: async () => "D1",
    userName: async () => ({}),
    conversationHistory: async () => ({ messages: [], hasMore: false }),
    conversationReplies: async () => ({ messages: [] }),
    memberChannels: async () => ({ channels: [] }),
    addReaction: async () => {},
    removeReaction: async () => {},
    ...overrides,
  };
}

function descriptor(overrides: Partial<SlackAppDescriptorDeps> = {}) {
  return makeSlackAppDescriptor({
    api: fakeApi(),
    cloud: cloud({}, [[WORKSPACE]]),
    depositUrl: async () => DEPOSIT_URL,
    deliveryAttempts: 4,
    listens: () => true,
    approval: fast,
    ...overrides,
  });
}

const MATERIAL = { teamId: "T_A", botUserId: "U_BOT", depositKey: "key-1" };

function kit(overrides: Partial<RuntimeKit> = {}) {
  const persisted: Record<string, string>[] = [];
  let ingress: ((input: unknown) => Promise<unknown>) | null = null;
  const built: RuntimeKit = {
    connectionId: "c1",
    persist: async (material) => {
      persisted.push(material);
    },
    registerIngress: (handler) => {
      ingress = handler;
      return () => {
        ingress = null;
      };
    },
    ...overrides,
  };
  return { kit: built, persisted, ingress: () => ingress };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("connecting Rome's Slack app (R1)", () => {
  it("goes from Connect through Slack's approve screen to a grant with no form and no Slack token", async () => {
    const c = cloud();
    const { interact, prompts, shown } = interaction();
    const grant = await setup(c)(interact, ctx);

    expect(prompts).toHaveLength(0);
    expect(c.connect).toHaveBeenCalledWith(DEPOSIT_URL, expect.anything());
    expect(shown.at(-1)?.links).toEqual([{ label: "Open Slack", url: INSTALL_URL }]);
    expect(grant.profile).toEqual({
      teamId: "T_A",
      workspaceName: "Acme",
      botUserId: "U_BOT",
      installerUserId: "U_GUARDIAN",
    });
    expect(grant.credential.material).toEqual({
      teamId: "T_A",
      botUserId: "U_BOT",
      depositKey: "key-1",
    });
    // The member who approved is the guardian there from their first message.
    expect(grant.guardianChannelUserId).toBe("T_A/U_GUARDIAN");
    expect(slackAppAccountId(grant.profile ?? {})).toBe("T_A/U_BOT");
  });

  it("takes a workspace approved again, which the Worker binds anew", async () => {
    const before = { ...WORKSPACE, boundAt: 1_000 };
    const grant = await setup(cloud({}, [[before], [before], [WORKSPACE]]))(
      interaction().interact,
      ctx,
    );
    expect(grant.profile?.teamId).toBe("T_A");
  });

  it("names the account the way the Slack bot kind does", () => {
    const d = descriptor();
    expect(d.link).toBe("own_account");
    expect(d.severalAccounts).toBeUndefined();
    expect(d.accountIdOf?.({ teamId: "T_A", botUserId: "U_BOT" })).toBe("T_A/U_BOT");
  });

  it("tells the guardian when Slack was not approved in time", async () => {
    await expect(
      makeSlackAppSetup({
        cloud: cloud({}, [[]]),
        depositUrl: async () => DEPOSIT_URL,
        approval: { pollMs: 1, limitMs: 5 },
      })(interaction().interact, ctx),
    ).rejects.toThrow(/was not added/);
  });

  it("waits for a mailbox before asking Slack", async () => {
    const c = cloud();
    await expect(setup(c, null)(interaction().interact, ctx)).rejects.toThrow(
      /can't receive Slack messages yet/,
    );
    expect(c.installUrl).not.toHaveBeenCalled();
  });

  it("holds Slack frames from the Worker's connect until its grant has had time to make the connection", async () => {
    const realSetTimeout = globalThis.setTimeout;
    let afterCommit: (() => void) | undefined;
    const timers = rs.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      delay?: number,
    ) => {
      if (delay === 5_000) {
        afterCommit = callback;
        return { unref: () => {} } as never;
      }
      return realSetTimeout(callback, delay);
    }) as never);
    try {
      const events: string[] = [];
      const grant = await makeSlackAppSetup({
        cloud: cloud(),
        depositUrl: async () => DEPOSIT_URL,
        approval: { pollMs: 0, limitMs: 1_000 },
        holdSlackFrames: () => {
          events.push("held");
          return () => events.push("released");
        },
      })(interaction().interact, ctx);
      expect(grant.profile?.teamId).toBe("T_A");
      expect(events).toEqual(["held"]);
      afterCommit?.();
      expect(events).toEqual(["held", "released"]);
    } finally {
      timers.mockRestore();
    }
  });

  it("lets go of its hold at once when the setup fails", async () => {
    const events: string[] = [];
    await expect(
      makeSlackAppSetup({
        cloud: cloud({}, [[]]),
        depositUrl: async () => DEPOSIT_URL,
        approval: { pollMs: 1, limitMs: 5 },
        holdSlackFrames: () => {
          events.push("held");
          return () => events.push("released");
        },
      })(interaction().interact, ctx),
    ).rejects.toThrow(/was not added/);
    expect(events).toEqual(["held", "released"]);
  });

  it("fails the setup with the Worker's reason, in the guardian's words", async () => {
    const c = cloud({
      connect: rs.fn(async () => {
        throw new SlackAppRefused("not_enrolled", "Link it in Settings, then connect again.", 0);
      }),
    });
    await expect(setup(c)(interaction().interact, ctx)).rejects.toThrow(
      "Link it in Settings, then connect again.",
    );
  });
});

describe("the Slack app talker", () => {
  it("connects on start, checks the deposits it is handed with the grant's key, and sends through the Worker", async () => {
    const postMessage = rs.fn(async () => ({ ts: "3.0" }));
    const c = cloud({}, [[WORKSPACE]]);
    const d = descriptor({ api: fakeApi({ postMessage }), cloud: c });
    const k = kit();
    const talker = d.capabilities.talker?.build({ material: MATERIAL, expiresAt: "never" }, k.kit);
    const faults: unknown[] = [];
    const heard: string[] = [];
    talker?.start(
      (message) => void heard.push(message.content.text),
      (fault) => faults.push(fault),
    );
    await settle();
    expect(faults).toEqual([]);
    expect(c.connect).toHaveBeenCalledWith(DEPOSIT_URL);
    // The registry hands `deliver`'s acceptance only to a Talker that declares
    // it waits, and the mailbox is answered only once Chats has the message.
    expect(talker?.awaitsAcceptance).toBe(true);

    const body = new TextEncoder().encode(
      JSON.stringify({
        type: "event_callback",
        team_id: "T_A",
        event_id: "Ev1",
        event: {
          type: "message",
          channel_type: "im",
          channel: "D1",
          user: "U_GUARDIAN",
          text: "hello",
          ts: "1.0",
        },
      }),
    );
    const ingest = k.ingress();
    expect(
      await ingest?.({
        headers: { [SLACK_SIGNATURE_HEADER]: depositSignature(body, "key-1") },
        body,
      }),
    ).toEqual({ status: 200 });
    expect(
      await ingest?.({
        headers: { [SLACK_SIGNATURE_HEADER]: depositSignature(body, "another-rome") },
        body,
      }),
    ).toEqual({ status: 401 });
    expect(heard).toEqual(["hello"]);

    expect(await talker?.send("D1" as never, { text: "hi" } as never)).toMatchObject({
      messageId: "3.0",
    });
    expect(postMessage).toHaveBeenCalledWith(
      "T_A",
      { channel: "D1", markdown: "hi", threadTs: undefined },
      expect.anything(),
    );
    await talker?.stop();
    expect(k.ingress()).toBeNull();
  });

  it("has the instance's mailbox drained while it runs, claimed once its ingress takes frames", async () => {
    let claims = 0;
    const k = kit();
    const ingressAtClaim: boolean[] = [];
    const talker = descriptor({
      claimMailbox: () => {
        claims++;
        // The claim resumes a frame the drain held, which must find the ingress.
        ingressAtClaim.push(k.ingress() !== null);
        return () => {
          claims--;
        };
      },
    }).capabilities.talker?.build({ material: MATERIAL, expiresAt: "never" }, k.kit);
    talker?.start(
      () => {},
      () => {},
    );
    expect(claims).toBe(1);
    expect(ingressAtClaim).toEqual([true]);
    await talker?.stop();
    expect(claims).toBe(0);
  });

  it("keeps a new deposit key the Worker gives, and checks deposits with it", async () => {
    const c = cloud({
      connect: rs.fn(async () => ({ depositKey: "key-2", workspaces: [WORKSPACE] })),
    });
    const k = kit();
    const talker = descriptor({ cloud: c }).capabilities.talker?.build(
      { material: MATERIAL, expiresAt: "never" },
      k.kit,
    );
    talker?.start(
      () => {},
      () => {},
    );
    await settle();
    expect(k.persisted).toEqual([{ ...MATERIAL, depositKey: "key-2" }]);
    const body = new TextEncoder().encode(
      JSON.stringify({ type: "event_callback", team_id: "T_A", event_id: "Ev2", event: {} }),
    );
    expect(
      await k.ingress()?.({
        headers: { [SLACK_SIGNATURE_HEADER]: depositSignature(body, "key-2") },
        body,
      }),
    ).toEqual({ status: 200 });
  });

  it("says the connection is broken when the Worker no longer holds its workspace for this Rome (R8)", async () => {
    const talker = descriptor({ cloud: cloud({}, [[]]) }).capabilities.talker?.build(
      { material: MATERIAL, expiresAt: "never" },
      kit().kit,
    );
    const faults: unknown[] = [];
    talker?.start(
      () => {},
      (fault) => faults.push(fault),
    );
    await settle();
    expect(faults).toHaveLength(1);
    expect(faults[0]).toBeInstanceOf(CredentialRejected);
  });

  it("keeps the grant authorized when Rome Cloud refuses this Rome's own token, and retries", async () => {
    for (const refusal of [
      new SlackAppRefused("unauthorized", "Rome Cloud did not accept this Rome.", 401),
      new SlackAppRefused("not_enrolled", "Link it in Settings, then connect again.", 0),
    ]) {
      const talker = descriptor({
        cloud: cloud({
          connect: rs.fn(async () => {
            throw refusal;
          }),
        }),
      }).capabilities.talker?.build({ material: MATERIAL, expiresAt: "never" }, kit().kit);
      const faults: unknown[] = [];
      talker?.start(
        () => {},
        (fault) => faults.push(fault),
      );
      await settle();
      expect(faults).toHaveLength(1);
      expect(faults[0]).toBeInstanceOf(Disconnected);
      expect(faults[0]).not.toBeInstanceOf(CredentialRejected);
      expect(String((faults[0] as Disconnected).cause)).toContain("can't reach Rome Cloud");
    }
  });

  it("sends nothing as a refused credential while this Rome can't sign in to Rome Cloud", async () => {
    const talker = descriptor({
      api: fakeApi({
        postMessage: async () => {
          throw new SlackApiError(ROME_CLOUD_UNAVAILABLE, "Rome can't reach Rome Cloud.");
        },
      }),
    }).capabilities.talker?.build({ material: MATERIAL, expiresAt: "never" }, kit().kit);
    const failed = await talker
      ?.send("D1" as never, { text: "hi" } as never)
      .catch((error: unknown) => error);
    expect(failed).toMatchObject({ code: ROME_CLOUD_UNAVAILABLE });
    expect(failed).not.toBeInstanceOf(CredentialRejected);
  });

  it("keeps working on the stored key while the Worker is unreachable", async () => {
    const c = cloud({
      connect: rs.fn(async () => {
        throw new SlackAppRefused("http_503", "unavailable", 503);
      }),
    });
    const k = kit();
    const talker = descriptor({ cloud: c }).capabilities.talker?.build(
      { material: MATERIAL, expiresAt: "never" },
      k.kit,
    );
    const faults: unknown[] = [];
    talker?.start(
      () => {},
      (fault) => faults.push(fault),
    );
    await settle();
    expect(faults).toEqual([]);
    expect(k.persisted).toEqual([]);
  });

  it("says a grant that held a Slack token on this Rome needs approving again (R15)", async () => {
    const c = cloud();
    const k = kit();
    const talker = descriptor({ cloud: c }).capabilities.talker?.build(
      {
        material: {
          teamId: "T_A",
          botUserId: "U_BOT",
          botToken: "xoxb-old",
          forwardSecret: "secret",
          connectUrl: "wss://relay.test/c/mbx",
          drainKey: "k",
        },
        expiresAt: "never",
      },
      k.kit,
    );
    const faults: unknown[] = [];
    talker?.start(
      () => {},
      (fault) => faults.push(fault),
    );
    await settle();
    expect(faults).toHaveLength(1);
    expect(faults[0]).toBeInstanceOf(CredentialRejected);
    expect(String((faults[0] as CredentialRejected).cause)).toContain(REAPPROVE_FOR_GATEWAY);
    expect(c.connect).not.toHaveBeenCalled();
    expect(k.ingress()).toBeNull();
    await expect(talker?.send("D1" as never, { text: "hi" } as never)).rejects.toBeInstanceOf(
      CredentialRejected,
    );
  });
});

describe("the Slack app's channels in chat settings", () => {
  function channelTalker(memberChannels: SlackAppWebApi["memberChannels"]) {
    return descriptor({ api: fakeApi({ memberChannels }) }).capabilities.talker?.build(
      { material: MATERIAL, expiresAt: "never" },
      kit().kit,
    );
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

  it("reports a workspace the Worker no longer holds as a rejected credential", async () => {
    const talker = channelTalker(async () => {
      throw new SlackApiError("app_uninstalled");
    });

    await expect(talker?.directory?.listConversations({ limit: 10 })).rejects.toBeInstanceOf(
      CredentialRejected,
    );
  });
});

describe("disconnecting the Slack app in Rome (R8)", () => {
  const signal = new AbortController().signal;

  it("asks the Worker to revoke the token at Slack and let go of the workspace", async () => {
    const c = cloud();
    await descriptor({ cloud: c }).onDisconnect?.(
      { material: MATERIAL, expiresAt: "never" } as never,
      { signal } as never,
    );
    expect(c.disconnect).toHaveBeenCalledWith(signal);
  });

  it("revokes at Slack a token a grant from before the Worker holds, and still disconnects when Slack refuses", async () => {
    for (const answer of [null, "ratelimited"]) {
      const c = cloud();
      const revoked: string[] = [];
      await descriptor({
        cloud: c,
        revokeLegacyToken: async (token) => {
          revoked.push(token);
          return answer;
        },
      }).onDisconnect?.(
        { material: { botToken: "xoxb-old", teamId: "T_A" }, expiresAt: "never" } as never,
        { signal } as never,
      );
      expect(revoked).toEqual(["xoxb-old"]);
      expect(c.disconnect).toHaveBeenCalledWith(signal);
    }
  });

  it("makes no call to Slack for a grant with no token", async () => {
    const revoked: string[] = [];
    await descriptor({
      revokeLegacyToken: async (token) => {
        revoked.push(token);
        return null;
      },
    }).onDisconnect?.({ material: MATERIAL, expiresAt: "never" } as never, { signal } as never);
    expect(revoked).toEqual([]);
  });

  it("says the Worker kept the workspace when it could not let go", async () => {
    const c = cloud({
      disconnect: rs.fn(async () => {
        throw new SlackAppRefused("http_503", "unavailable", 503);
      }),
    });
    await expect(
      descriptor({ cloud: c }).onDisconnect?.(
        { material: MATERIAL, expiresAt: "never" } as never,
        { signal } as never,
      ),
    ).rejects.toThrow(/did not let go of this Rome/);
  });
});

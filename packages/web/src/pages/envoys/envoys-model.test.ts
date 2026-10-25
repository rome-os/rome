import { describe, expect, it } from "@rstest/core";
import { MAIN_AGENT_ID } from "@rome/api-types/account-agents";
import type { ApiConnection } from "@/lib/connections-api";
import { buildEnvoys, connectChoices } from "./envoys-model";

function connection(overrides: Partial<ApiConnection> & { connectionKind: string }): ApiConnection {
  return {
    id: `${overrides.connectionKind}-id`,
    label: overrides.connectionKind,
    grants: { bot: "authorized" },
    display: { bot: null },
    capabilities: {
      talk: { state: "unlocked" },
      act: { state: "unsupported" },
      watch: { state: "unsupported" },
    },
    connect: null,
    setups: {},
    channel: overrides.connectionKind,
    agent: null,
    ...overrides,
  };
}

describe("buildEnvoys", () => {
  it("groups connected accounts by agent, main first", () => {
    const { envoys, unlinked } = buildEnvoys(
      [
        connection({ connectionKind: "discord", agent: "sales:agent" }),
        connection({
          connectionKind: "feishu",
          agent: MAIN_AGENT_ID,
          display: {
            bot: { displayName: "Sales", handle: null, email: null, avatarUrl: null },
          },
        }),
        connection({ connectionKind: "telegram", agent: "main" }),
      ],
      [{ name: "main", description: "The guardian's agent" }],
    );
    expect(envoys.map((envoy) => envoy.agent)).toEqual([MAIN_AGENT_ID, "sales:agent"]);
    expect(envoys[0]!.description).toBe("The guardian's agent");
    expect(envoys[0]!.accounts.map((account) => account.name)).toEqual(["Sales", "Telegram"]);
    expect(unlinked).toEqual([]);
  });

  it("names an account with no name after its platform, Lark apart from Feishu", () => {
    const { unlinked } = buildEnvoys(
      [
        connection({ connectionKind: "feishu", platform: "feishu" }),
        connection({
          connectionKind: "feishu",
          id: "lark-id",
          channel: "lark-app",
          platform: "lark",
        }),
        // A core that predates `platform`.
        connection({ connectionKind: "telegram_user", channel: "telegram_user" }),
      ],
      [],
    );
    expect(unlinked.map(({ platform, name }) => ({ platform, name }))).toEqual([
      { platform: "feishu", name: "Feishu" },
      { platform: "lark", name: "Lark" },
      { platform: "telegram", name: "Telegram" },
    ]);
  });

  it("lists connected accounts with no agent apart", () => {
    const { envoys, unlinked } = buildEnvoys([connection({ connectionKind: "feishu" })], []);
    expect(envoys).toEqual([]);
    expect(unlinked.map((account) => account.channel)).toEqual(["feishu"]);
  });

  it("leaves out accounts that cannot carry an agent", () => {
    const { envoys, unlinked } = buildEnvoys(
      [
        // Not a linkable service.
        connection({ connectionKind: "whatsapp" }),
        // Never connected.
        connection({ connectionKind: "discord", grants: { bot: "unauthorized" } }),
        // A placeholder.
        connection({ connectionKind: "telegram", id: null, channel: null }),
        // A core that predates agent links.
        connection({ connectionKind: "feishu", agent: undefined }),
      ],
      [],
    );
    expect(envoys).toEqual([]);
    expect(unlinked).toEqual([]);
  });

  it("offers main even before the agent list loads", () => {
    expect(buildEnvoys([], null).agents).toEqual([MAIN_AGENT_ID]);
  });

  it("offers the loaded agents, main first, and not a linked one core no longer loads", () => {
    const { agents } = buildEnvoys(
      [connection({ connectionKind: "discord", agent: "sales:agent" })],
      [{ name: "build" }, { name: "main" }],
    );
    expect(agents).toEqual([MAIN_AGENT_ID, "build"]);
  });

  it("falls back to the linked agents while the agent list is missing", () => {
    const { agents } = buildEnvoys(
      [connection({ connectionKind: "discord", agent: "sales:agent" })],
      null,
    );
    expect(agents).toEqual([MAIN_AGENT_ID, "sales:agent"]);
  });

  it("marks the guardian's own account as a delegate with no card to open", () => {
    const own = (agent: string | null) =>
      connection({
        connectionKind: "telegram_user",
        channel: "telegram_user",
        grants: { session: "authorized" },
        display: { session: null },
        agent,
      });
    const { envoys } = buildEnvoys([own(MAIN_AGENT_ID)], []);
    expect(envoys[0]!.accounts[0]).toMatchObject({
      kind: "delegate",
      platform: "telegram",
      route: null,
      connectionId: "telegram_user-id",
      grant: "session",
    });
    expect(buildEnvoys([own(null)], []).unlinked.map((account) => account.kind)).toEqual([
      "delegate",
    ]);
  });
});

describe("connectChoices", () => {
  const placeholder = (service: string) =>
    connection({
      connectionKind: service,
      id: null,
      channel: null,
      grants: { bot: "unauthorized" },
    });

  it("starts even a first account as a new one where the service offers several", () => {
    const [choice] = connectChoices([
      connection({
        connectionKind: "telegram",
        grants: { bot: "unauthorized" },
        severalAccounts: true,
        setups: { bot: "cid-old" },
      }),
    ]);
    expect(choice).toMatchObject({ another: true, activeSetupCid: null, taken: false });
  });

  it("re-attaches the setup of a service that holds one account", () => {
    const [choice] = connectChoices([
      connection({
        connectionKind: "telegram_user",
        id: "left",
        grants: { session: "unauthorized" },
        setups: { session: "cid-live" },
      }),
    ]);
    expect(choice).toMatchObject({ another: false, activeSetupCid: "cid-live", taken: false });
  });

  it("marks a service whose one account is connected as taken", () => {
    const [choice] = connectChoices([
      connection({ connectionKind: "telegram_user", grants: { session: "authorized" } }),
    ]);
    expect(choice).toMatchObject({ kind: "delegate", platform: "telegram", taken: true });
  });

  it("offers a Slack account on the Slack platform", () => {
    const [choice] = connectChoices([
      connection({
        connectionKind: "slack_bot",
        id: null,
        channel: null,
        grants: { bot: "unauthorized" },
        severalAccounts: true,
      }),
    ]);
    expect(choice).toMatchObject({ kind: "own", platform: "slack", another: true, taken: false });
  });

  it("offers own accounts first and leaves out services core does not register", () => {
    const choices = connectChoices([
      placeholder("telegram_user"),
      placeholder("discord"),
      placeholder("feishu"),
      placeholder("whatsapp"),
    ]);
    expect(choices.map((choice) => choice.service)).toEqual(["feishu", "discord", "telegram_user"]);
  });
});

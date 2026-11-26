import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type {
  ChatId,
  ChatSettings,
  ChatSettingsControl,
  ChatSettingsSnapshot,
} from "@rome-os/app-runtime";
import type { Command } from "../connections/index.js";
import { entrance } from "../participation/entrance.js";
import type { Entry, EntryAccount } from "../participation/entry.js";
import { type ChatCommandsDeps, chatCommands, type RanBy } from "./chat-commands.js";

const CONNECTION_ID = "connection:discord";
const CHANNEL_ID = "channel-1" as ChatId;
const GUARDIAN_ID = "discord-guardian-777";
const MEMBER_ID = "discord-member-555";
const UNLINKED_ID = "discord-user-888";

function makeSettings() {
  const effective: ChatSettings = {
    enabled: true,
    activation: { mode: "mention", botMessages: "ignore", whenOthersMentioned: "ignore" },
    replies: { placement: "thread" },
    routing: { agentName: null },
    session: { reset: { mode: "idle", idleMinutes: 10_080 } },
  };
  const snapshot = {
    conversation: {
      ref: { connectionId: CONNECTION_ID, chatId: CHANNEL_ID },
      connectionKind: "discord",
      service: "discord",
      kind: "channel",
      displayName: "general",
    },
    supportedFields: ["enabled", "routing.agentName"],
    effective,
    overrides: {},
  } as ChatSettingsSnapshot;
  const control = {
    get: rs.fn(async () => snapshot),
    update: rs.fn(async () => snapshot),
    reset: rs.fn(async () => snapshot),
    list: rs.fn(async () => ({ items: [] })),
  };
  return { control, snapshot };
}

function commands(overrides: Partial<ChatCommandsDeps> = {}) {
  const settings = makeSettings();
  const enter = rs.fn(async ({ id }: EntryAccount): Promise<Entry<RanBy>> => {
    if (id === GUARDIAN_ID) return { kind: "entered", person: { kind: "guardian" } };
    if (id === MEMBER_ID) return { kind: "entered", person: { kind: "visitor" } };
    return { kind: "unknown" };
  });
  // As the host hands them to a connection.
  const answer = entrance({ enter }).commands(
    "discord",
    chatCommands({
      connectionId: CONNECTION_ID,
      service: "discord",
      settings: settings.control as unknown as ChatSettingsControl,
      ...overrides,
    }),
  );
  return { answer, settings, enter };
}

function command(
  path: string[],
  input: { by?: string; options?: Record<string, string>; direct?: boolean } = {},
): Command {
  return {
    where: {
      chatId: CHANNEL_ID,
      kind: input.direct ? "direct" : "group",
      ...(input.direct ? {} : { name: "general" }),
    },
    sender: { accountId: input.by ?? GUARDIAN_ID },
    receivedBy: "bot",
    path,
    options: input.options ?? {},
  };
}

afterEach(() => {
  rs.restoreAllMocks();
});

describe("chat commands, for the guardian", () => {
  it("lists a channel's rules on `/channel status`", async () => {
    const { answer, settings } = commands();

    const said = await answer.ran(command(["channel", "status"]));

    expect(settings.control.get).toHaveBeenCalledWith({
      connectionId: CONNECTION_ID,
      chatId: CHANNEL_ID,
    });
    expect(said).toContain("**#general configuration**");
  });

  it("routes a channel to a loaded agent on `/channel agent set`", async () => {
    const { answer, settings } = commands({ listAgents: () => ["main", "pm-assistant"] });

    const said = await answer.ran(
      command(["channel", "agent", "set"], { options: { name: "pm-assistant" } }),
    );

    expect(settings.control.update).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: { connectionId: CONNECTION_ID, chatId: CHANNEL_ID },
        set: { routing: { agentName: "pm-assistant" } },
        actor: { kind: "guardian", id: "discord-slash" },
      }),
    );
    expect(said).toContain("now routes to agent `pm-assistant`");
  });

  it("names the account's agent in status and after a clear", async () => {
    const { answer } = commands({ accountAgent: () => "sales:agent" });

    expect(await answer.ran(command(["channel", "status"]))).toContain("agent: sales:agent");
    expect(await answer.ran(command(["channel", "agent", "clear"]))).toContain(
      "messages now route to sales:agent",
    );
  });

  it("names the account's agent in status when the stored agent is not loaded", async () => {
    const { answer, settings } = commands({
      accountAgent: () => "sales:agent",
      hasAgent: (name) => name === "sales:agent",
    });
    settings.snapshot.effective.routing.agentName = "gone:agent";

    expect(await answer.ran(command(["channel", "status"]))).toContain("agent: sales:agent");
  });

  it("says no agent answers when the account has no agent", async () => {
    const { answer } = commands({ accountAgent: () => null });

    expect(
      await answer.ran(command(["channel", "agent", "set"], { options: { name: "main" } })),
    ).toContain("no agent answers here");
  });

  it("pins a channel to main on `set main`", async () => {
    const { answer, settings } = commands({ accountAgent: () => "sales:agent" });

    const said = await answer.ran(
      command(["channel", "agent", "set"], { options: { name: "main" } }),
    );

    expect(settings.control.update).toHaveBeenCalledWith(
      expect.objectContaining({ set: { routing: { agentName: "main" } } }),
    );
    expect(said).toContain("pinned to main — messages now route to main");
  });

  it("follows the account's agent in a direct message, whatever agent is stored", async () => {
    const { answer, settings } = commands({
      accountAgent: () => "sales:agent",
      listAgents: () => ["pm-assistant", "sales:agent"],
    });
    settings.snapshot.effective.routing.agentName = "pm-assistant";

    expect(await answer.ran(command(["channel", "status"], { direct: true }))).toContain(
      "agent: sales:agent",
    );
    expect(
      await answer.ran(
        command(["channel", "agent", "set"], { options: { name: "pm-assistant" }, direct: true }),
      ),
    ).toContain("stored agent `pm-assistant`, but messages now route to sales:agent");
  });

  it("switches a channel off on `/channel ignore`", async () => {
    const { answer, settings } = commands();

    await answer.ran(command(["channel", "ignore"]));

    expect(settings.control.update).toHaveBeenCalledWith(
      expect.objectContaining({ set: { enabled: false }, clear: [] }),
    );
  });

  it("suggests the loaded agents but main while an agent name is typed", async () => {
    const { answer } = commands({ listAgents: () => ["main", "pm-assistant", "sales:agent"] });

    expect(await answer.suggest(command(["channel", "agent", "set"]), "name", "SAL")).toEqual([
      "sales:agent",
    ]);
  });
});

describe("chat commands, for a member", () => {
  it("records a member's change as theirs", async () => {
    const { answer, settings } = commands();

    await answer.ran(command(["channel", "ignore"], { by: MEMBER_ID }));
    await answer.ran(command(["channel", "reset"], { by: MEMBER_ID }));

    expect(settings.control.update).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { kind: "member", id: "discord-slash" } }),
    );
    expect(settings.control.reset).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { kind: "member", id: "discord-slash" } }),
    );
  });
});

describe("chat commands, for anyone else", () => {
  it("refuses a sender no person is linked to", async () => {
    const { answer, settings, enter } = commands({ listAgents: () => ["pm-assistant"] });

    const said = await answer.ran(
      command(["channel", "agent", "set"], { by: UNLINKED_ID, options: { name: "pm-assistant" } }),
    );

    expect(enter).toHaveBeenCalledWith({ platform: "discord", id: UNLINKED_ID });
    expect(settings.control.get).not.toHaveBeenCalled();
    expect(settings.control.update).not.toHaveBeenCalled();
    expect(said).toBe("Only the guardian and members of this Rome can run its commands.");
  });

  it("suggests no agents to a sender no person is linked to", async () => {
    const listAgents = rs.fn(() => ["main", "private-agent"]);
    const { answer } = commands({ listAgents });

    expect(
      await answer.suggest(command(["channel", "agent", "set"], { by: UNLINKED_ID }), "name", ""),
    ).toEqual([]);
    expect(listAgents).not.toHaveBeenCalled();
  });

  it("stops the chat's turn on `/stop`, for someone let in alone", async () => {
    const chatStop = rs.fn(async () => ({ status: "stop_requested" as const, turnId: "turn-1" }));
    const { answer } = commands({ chatStop });

    expect(await answer.ran(command(["stop"], { by: UNLINKED_ID }))).toBe(
      "Only the guardian and members of this Rome can run its commands.",
    );
    expect(chatStop).not.toHaveBeenCalled();

    expect(await answer.ran(command(["stop"]))).toBe("Stopped.");
    expect(chatStop).toHaveBeenCalledWith({
      ref: { connectionId: CONNECTION_ID, chatId: CHANNEL_ID },
      service: "discord",
      senderId: GUARDIAN_ID,
    });
  });
});

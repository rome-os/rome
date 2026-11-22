import { describe, expect, it, rs } from "@rstest/core";
import type { RuntimeKit, Talker } from "../../types.js";
import { createDiscordAppDescriptor, makeDiscordAppSetup } from "./descriptor.js";
import type { DiscordAppCloud } from "./worker.js";
import { DiscordAppRefused } from "./worker.js";

const people = { nameOf: async () => undefined };

function cloud(over: Partial<DiscordAppCloud> = {}): DiscordAppCloud {
  return {
    connect: async () => ({ botId: "1", botUsername: "Rome", depositKey: "key-1" }),
    disconnect: async () => {},
    bindings: async () => ({ servers: [], users: [] }),
    servers: async () => [],
    removeServer: async () => ({ removed: true, left: true }),
    send: async () => ({ id: "9" }),
    typing: async () => {},
    react: async () => {},
    unreact: async () => {},
    installUrl: async () => "https://discord.com/oauth2/authorize",
    ...over,
  };
}

const ctx = {
  step: <T>(_label: string, fn: () => Promise<T>) => fn(),
  signal: new AbortController().signal,
} as never;

describe("Rome's Discord bot connection", () => {
  it("connects with no form, keeping the Worker's key and the bot it answers as", async () => {
    const setup = makeDiscordAppSetup({
      cloud: cloud(),
      depositUrl: async () => "https://ingest.test/h/a.b",
      ...people,
    });
    const grant = await setup({} as never, ctx);
    expect(grant.credential.material).toEqual({
      depositKey: "key-1",
      botId: "1",
      botUsername: "Rome",
    });
    expect(grant.profile).toEqual({ botId: "1", botUsername: "Rome" });
  });

  it("says why it cannot connect yet, in the guardian's words", async () => {
    await expect(
      makeDiscordAppSetup({ cloud: cloud(), depositUrl: async () => null, ...people })(
        {} as never,
        ctx,
      ),
    ).rejects.toThrow("Rome can't receive Discord messages yet");
    const refusing = cloud({
      connect: async () => {
        throw new DiscordAppRefused(
          "discord_unavailable",
          "Discord is unavailable right now.",
          503,
        );
      },
    });
    await expect(
      makeDiscordAppSetup({
        cloud: refusing,
        depositUrl: async () => "https://ingest.test/h/a.b",
        ...people,
      })({} as never, ctx),
    ).rejects.toThrow("Discord is unavailable right now.");
  });

  it("answers as the guardian's Concierge with no chat rules, and lets go at the Worker on disconnect", async () => {
    const disconnect = rs.fn(async () => {});
    const descriptor = createDiscordAppDescriptor({
      cloud: cloud({ disconnect }),
      depositUrl: async () => null,
      ...people,
    });
    expect(descriptor).toMatchObject({
      connectionKind: "discord_app",
      label: "Discord",
      link: "own_account",
      startsWithConcierge: true,
      chatRules: { offers: [] },
    });
    expect(descriptor.accountIdOf?.({ botId: "1", botUsername: "Rome" })).toBe("1");
    await descriptor.onDisconnect?.(
      { material: {}, profile: {} },
      { signal: new AbortController().signal },
    );
    expect(disconnect).toHaveBeenCalled();
  });

  it("acknowledges without waiting for the record, and keeps a key the Worker made anew on start", async () => {
    const persisted: unknown[] = [];
    let ingress: ((input: unknown) => Promise<unknown>) | undefined;
    const kit = {
      connectionId: "conn-1",
      persist: async (material: unknown) => {
        persisted.push(material);
      },
      registerIngress: (handler: (input: unknown) => Promise<unknown>) => {
        ingress = handler;
        return () => {
          ingress = undefined;
        };
      },
    } as unknown as RuntimeKit;
    const descriptor = createDiscordAppDescriptor({
      cloud: cloud({
        connect: async () => ({ botId: "1", botUsername: "Rome", depositKey: "key-2" }),
      }),
      depositUrl: async () => "https://ingest.test/h/a.b",
      ...people,
    });
    const talker = descriptor.capabilities.talker?.build(
      { material: { depositKey: "key-1", botId: "1", botUsername: "Rome" }, expiresAt: "never" },
      kit,
    ) as Talker;
    // A failure of ours is never handed back to the shared mailbox.
    expect(talker.awaitsAcceptance).toBeUndefined();
    // Typing, by the dashboard's rule, and reactions, through the Worker.
    expect(talker.typing).toBeDefined();
    expect(talker.reactions).toBeDefined();
    talker.start(
      () => Promise.resolve(),
      () => {},
    );
    expect(ingress).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(persisted).toEqual([{ depositKey: "key-2", botId: "1", botUsername: "Rome" }]);
    // A frame not signed with the key answers 401 through the ingress.
    expect(await ingress?.({ body: new Uint8Array(), signature: "00" })).toEqual({ status: 401 });
    await talker.stop();
    expect(ingress).toBeUndefined();
  });
});

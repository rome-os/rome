import { DiscordAPIError, HTTPError, type REST } from "discord.js";
import { describe, expect, it } from "@rstest/core";
import { discordMarkdown, discordTransport } from "./discord.js";

const refusal = (status: number, code: number, message: string) =>
  new DiscordAPIError({ code, message }, code, status, "PATCH", "/channels/7/messages/41", {});

interface Call {
  method: "post" | "patch";
  route: string;
  body: Record<string, unknown>;
}

/** The transport over a REST client that answers as `answer` says, noting each call. */
function transportOver(
  answer: (call: Call) => unknown,
  place: (chat: string, replyTo: string) => Promise<string> = async (chat) => chat,
) {
  const calls: Call[] = [];
  const request =
    (method: Call["method"]) =>
    async (route: string, { body }: { body: Record<string, unknown> }) => {
      const call = { method, route, body };
      calls.push(call);
      return answer(call);
    };
  const transport = discordTransport({
    rest: { post: request("post"), patch: request("patch") } as unknown as REST,
    place,
  });
  if (!transport.edit) throw new Error("The Discord transport declares edit");
  return { calls, create: transport.create, edit: transport.edit };
}

describe("discordTransport", () => {
  it("creates a message where the reply is placed, and names it by Discord's ids", async () => {
    const placed: string[][] = [];
    const { calls, create } = transportOver(
      () => ({ id: "41", channel_id: "thread-1" }),
      async (chat, replyTo) => {
        placed.push([chat, replyTo]);
        return "thread-1";
      },
    );

    expect(await create("7", "hello", "12")).toEqual({ messageId: "41", chatId: "thread-1" });
    expect(placed).toEqual([["7", "12"]]);
    // A whole reply does not point at the user's message, so a streamed one
    // does not either.
    expect(calls).toEqual([
      {
        method: "post",
        route: "/channels/thread-1/messages",
        body: { content: "hello", nonce: expect.any(String), enforce_nonce: true },
      },
    ]);
  });

  it("gives every create its own nonce of at most 25 characters", async () => {
    const { calls, create } = transportOver(() => ({ id: "41", channel_id: "7" }));

    await create("7", "a");
    await create("7", "b");
    const [first, second] = calls.map((call) => String(call.body.nonce));
    expect(first!.length).toBeLessThanOrEqual(25);
    expect(first).not.toBe(second);
  });

  it("writes a later message into its conversation without looking up a place", async () => {
    let looked = false;
    const { calls, create } = transportOver(
      () => ({ id: "42", channel_id: "thread-1" }),
      async () => {
        looked = true;
        return "elsewhere";
      },
    );

    await create("thread-1", "more");
    expect(looked).toBe(false);
    expect(calls[0]?.route).toBe("/channels/thread-1/messages");
  });

  it("edits a message's content in place", async () => {
    const { calls, edit } = transportOver(() => ({}));

    await edit({ messageId: "41", chatId: "7" }, "hello world");
    expect(calls).toEqual([
      { method: "patch", route: "/channels/7/messages/41", body: { content: "hello world" } },
    ]);
  });

  const failureOf = async (error: unknown) => {
    const { edit } = transportOver(() => {
      throw error;
    });
    return edit({ messageId: "41", chatId: "7" }, "text").catch((failed: unknown) => failed);
  };

  it("names a refused token unauthorized, and a refusal in one channel rejected", async () => {
    expect(await failureOf(refusal(401, 0, "401: Unauthorized"))).toMatchObject({
      kind: "unauthorized",
    });
    expect(await failureOf(refusal(403, 50007, "Cannot send messages to this user"))).toMatchObject(
      { kind: "rejected" },
    );
    expect(await failureOf(refusal(404, 10008, "Unknown Message"))).toMatchObject({
      kind: "rejected",
    });
  });

  it("names a server error that outlasted discord.js's retries unknown", async () => {
    expect(
      await failureOf(new HTTPError(502, "Bad Gateway", "PATCH", "/channels/7/messages/41", {})),
    ).toMatchObject({ kind: "unknown" });
  });

  it("names a write that never reached Discord unavailable, and a lost one unknown", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    expect(await failureOf(refused)).toMatchObject({ kind: "unavailable" });
    const aborted = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    expect(await failureOf(aborted)).toMatchObject({ kind: "unknown" });
  });

  it("names a create that failed to connect unknown, since an earlier attempt may have posted it", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    const { create } = transportOver(() => {
      throw refused;
    });
    await expect(create("7", "hello")).rejects.toMatchObject({ kind: "unknown" });
  });

  it("names a failed placement unavailable unless Discord refused it", async () => {
    const createThrough = (error: unknown) =>
      transportOver(
        () => ({ id: "41", channel_id: "7" }),
        async () => {
          throw error;
        },
      )
        .create("7", "hello", "12")
        .catch((failed: unknown) => failed);

    // A thread the lookup opened before its answer was lost is found again.
    const aborted = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    expect(await createThrough(aborted)).toMatchObject({ kind: "unavailable" });
    expect(await createThrough(refusal(403, 50001, "Missing Access"))).toMatchObject({
      kind: "rejected",
    });
  });
});

describe("Discord Markdown", () => {
  it("closes an unfinished fence in a preview, and leaves headings alone", () => {
    expect(discordMarkdown.render("# Plan\n```ts\nconst a = 1;", false)).toBe(
      "# Plan\n```ts\nconst a = 1;\n```",
    );
  });

  it("opens the code again in a message that continues it", () => {
    expect(
      discordMarkdown.render("const b = 2;\n```\nDone", true, { before: "```ts\nconst a = 1;\n" }),
    ).toBe("```ts\nconst b = 2;\n```\nDone");
  });
});

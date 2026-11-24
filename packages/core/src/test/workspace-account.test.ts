// An account that serves its workspace, booted in process on a stand-in kind
// of connection: anyone's mention wakes its one session, which answers from
// what was said around the mention, in the chat and thread that asked.

import { afterEach, describe, expect, it } from "@rstest/core";
import type { ChannelMessage, ChatId } from "@rome-os/app-runtime";
import { ROME_TOOL_GROUPS, type RomeTools } from "../agent/index.js";
import type { ModelProvider } from "../core/agent-runner.js";
import { createSessionFromRun } from "../core/agent-runner.js";
import type { ConnectionDescriptor, TalkHistoryRead } from "../connections/types.js";
import { bootWorkspaceAccount, type WorkspaceAccount } from "./kit/workspace-account.js";

const KIND = {
  connectionKind: "standin",
  grant: "standin",
  servesWorkspace: true,
} as unknown as ConnectionDescriptor;

/** The platform behind the stand-in: each address's messages, oldest first. */
function platform() {
  const said = new Map<string, ChannelMessage[]>();
  let clock = Date.UTC(2026, 10, 24, 9, 0);
  const say = (address: string, sender: string, text: string) => {
    const message = {
      channel: "standin",
      chatId: address,
      messageId: `m${clock}`,
      direction: "inbound",
      senderId: sender,
      senderDisplayName: sender,
      text,
      attachments: [],
      timestamp: new Date((clock += 1000)),
    } as unknown as ChannelMessage;
    said.set(address, [...(said.get(address) ?? []), message]);
    return message;
  };
  const history = {
    read: async (address: ChatId, read: TalkHistoryRead) =>
      (said.get(address) ?? [])
        .filter((message) => !read.until || message.timestamp <= read.until)
        .reverse()
        .slice(0, read.limit),
  };
  return { say, history };
}

/** A model that answers only from what it was shown: the line of its prompt
 *  that names what was asked about, said with `say`. */
function answeringModel(): ModelProvider {
  const callTool = (tools: RomeTools, name: string, input: Record<string, unknown>) => {
    const group = ROME_TOOL_GROUPS.find((each) =>
      tools.listTools(each).some((tool) => tool.name === name),
    );
    if (!group) throw new Error(`no tool ${name}`);
    return tools.callTool(group, name, input);
  };
  return {
    id: "mock",
    builtinTools: new Set<string>(),
    openSession: async (params) =>
      createSessionFromRun(
        "mock",
        async function* (run) {
          const asked = /when is the (\w+)\?/.exec(run.prompt)?.[1];
          const known = asked
            ? run.prompt.split("\n").find((line) => line.includes(`the ${asked} moved to`))
            : undefined;
          const answer = known ? known.slice(known.indexOf(`the ${asked}`)) : "I don't know.";
          await callTool(run.tools, "say", { text: answer });
          yield { type: "result", content: "done" };
        },
        params,
      ),
  };
}

describe("an account that serves its workspace", () => {
  let account: WorkspaceAccount | null = null;
  afterEach(async () => {
    await account?.close();
    account = null;
  });

  it("answers anyone's mention from what was said around it, in the chat and thread that asked", async () => {
    const stand = platform();
    account = await bootWorkspaceAccount({
      kind: KIND,
      model: answeringModel(),
      ports: {
        history: stand.history,
        send: async (place, text) => stand.say(place.thread ?? place.chat, "rome", text).messageId,
      },
    });

    // Said without a mention: the account stays quiet.
    stand.say("C1", "ann", "the launch moved to Friday");
    expect(
      await account.deliver({ sender: "ann", chat: "C1", text: "the launch moved to Friday" }),
    ).toEqual({ woke: false });
    stand.say("C2", "cy", "the offsite moved to May");
    stand.say("C2:T1", "cy", "@rome when is the offsite?");

    stand.say("C1", "bob", "@rome when is the launch?");
    expect(
      await account.deliver({
        sender: "bob",
        chat: "C1",
        text: "@rome when is the launch?",
        mentionsRome: true,
      }),
    ).toEqual({ woke: true });
    // In a thread, the chat's own messages are shown beside the thread's.
    await account.deliver({
      sender: "cy",
      chat: "C2",
      thread: "C2:T1",
      text: "@rome when is the offsite?",
      mentionsRome: true,
    });

    expect(account.sent).toEqual([
      { chat: "C1", thread: null, text: "the launch moved to Friday" },
      { chat: "C2", thread: "C2:T1", text: "the offsite moved to May" },
    ]);
  });
});

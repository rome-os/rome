// Chat reads over chats a test lists, as a host that offers Chats hands them.
import type { ChatLine, ChatReads, RecentChat } from "@rome-os/app-runtime/chats";

export interface FakeChat {
  chat: Partial<RecentChat> & { sessionId: string };
  lines: Array<Partial<ChatLine> & Pick<ChatLine, "role" | "content" | "createdAt">>;
}

const lastSaid = (chat: FakeChat): number =>
  Math.max(0, ...chat.lines.map((line) => line.createdAt.getTime()));

/** Chat reads over `chats`, most recently active first: a chat with no
 *  channel is a dashboard chat. */
export function fakeChatReads(chats: FakeChat[]): ChatReads {
  const linesOf = (chat: FakeChat): ChatLine[] =>
    chat.lines.map((line, index) => ({
      key: `${chat.chat.sessionId}:${index}`,
      turnId: null,
      senderId: null,
      senderName: null,
      ...line,
    }));
  return {
    async recentChats({ since, where }) {
      return chats
        .filter((chat) =>
          where === "dashboard"
            ? !chat.chat.channel
            : chat.chat.channel && where.accountKinds.includes(chat.chat.channel.kind),
        )
        .filter((chat) => chat.lines.some((line) => line.createdAt >= since))
        .sort((a, b) => lastSaid(b) - lastSaid(a))
        .map(({ chat }) => ({
          chat: { platform: chat.channel ? chat.channel.kind : "webchat", id: 1 },
          name: "Chat",
          threadName: null,
          ownerKey: "guardian",
          archived: false,
          channel: null,
          agentName: null,
          projectName: null,
          projectPath: null,
          startedAt: new Date(0),
          ...chat,
        }));
    },
    async transcript(sessionId, input = {}) {
      const chat = chats.find((c) => c.chat.sessionId === sessionId);
      const since = input.since ?? new Date(0);
      return chat ? linesOf(chat).filter((line) => line.createdAt >= since) : [];
    },
    async traces() {
      return [];
    },
  };
}

/** An app context whose host offers `reads`. */
export function withChatReads(reads: ChatReads): { repositories: { chats: ChatReads } } {
  return { repositories: { chats: reads } };
}

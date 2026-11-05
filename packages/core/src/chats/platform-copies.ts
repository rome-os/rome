// Which platforms' messages Chats keeps a copy of. Prototype: Chats stops
// copying a platform's messages where the platform, or its connection kind,
// holds the history itself, and keeps the chat row as the place (sessions,
// chat settings and reply rules key on it). The dashboard and assistants'
// chats on Rome Cloud keep their messages: Rome is their platform.

/** The platforms whose messages Chats no longer copies. */
const WITHOUT_COPIES: ReadonlySet<string> = new Set(["discord", "telegram"]);

/** Whether Chats keeps a copy of the messages said on `platform`. */
export function keepsCopies(platform: string): boolean {
  return !WITHOUT_COPIES.has(platform);
}

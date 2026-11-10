/**
 * The chats each person's phone app is showing now: each phone socket
 * holding a chat's `chat.watch:<id>` topic counts once, for the person signed
 * in on it, the guardian or a visitor. Its `chat.session:` subscriptions never
 * count. The Concierge does not push what it says in a chat its owner's phone
 * is watching, since they are reading it there. A socket that drops without
 * saying goodbye counts until the live-events ping drops it.
 */
export class PhoneWatching {
  private readonly counts = new Map<string, number>();

  /** Counts one more of `owner`'s phones on `chatId`; the result stops counting it, once. */
  watch(owner: string, chatId: string): () => void {
    const key = keyOf(owner, chatId);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.counts.get(key) ?? 1) - 1;
      if (left > 0) this.counts.set(key, left);
      else this.counts.delete(key);
    };
  }

  isWatching(owner: string, chatId: string): boolean {
    return (this.counts.get(keyOf(owner, chatId)) ?? 0) > 0;
  }
}

// An owner key never holds a newline, so the pair stays apart.
const keyOf = (owner: string, chatId: string) => `${owner}\n${chatId}`;

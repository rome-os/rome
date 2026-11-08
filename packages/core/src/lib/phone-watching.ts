/**
 * The chats the guardian's phone app is showing now: each guardian phone
 * socket holding a chat's `chat.watch:<id>` topic counts once. Its
 * `chat.session:` subscriptions never count. The Concierge does not
 * push what it says in a chat the phone is watching, since the guardian is
 * reading it there. A socket that drops without saying goodbye counts until
 * the live-events ping drops it.
 */
export class PhoneWatching {
  private readonly counts = new Map<string, number>();

  /** Counts one more phone on `chatId`; the result stops counting it, once. */
  watch(chatId: string): () => void {
    this.counts.set(chatId, (this.counts.get(chatId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.counts.get(chatId) ?? 1) - 1;
      if (left > 0) this.counts.set(chatId, left);
      else this.counts.delete(chatId);
    };
  }

  isWatching(chatId: string): boolean {
    return (this.counts.get(chatId) ?? 0) > 0;
  }
}

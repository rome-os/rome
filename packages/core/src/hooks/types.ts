export interface ChannelMessageHook {
  register(): Promise<void>;
  /** @deprecated A hook reaches every Connection through the channels it
   *  subscribes to in `register`, and can make this a no-op. The host still
   *  calls it on each Talk unlock, so a hook that subscribes per Connection
   *  keeps hearing messages until this is removed. */
  registerConnection(connectionId: string, service: string): void;
  /** Detach every subscription `register`/`registerConnection` took out, so
   * the host can swap in a replacement instance (e.g. after an app-keys
   * environment change) without double-handling inbound messages. A hook
   * without this method cannot be hot-swapped and stays live until restart. */
  unregister?(): void;
}

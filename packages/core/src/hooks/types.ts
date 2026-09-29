export interface ChannelMessageHook {
  register(): Promise<void>;
  /** @deprecated A hook reaches every Connection through the channels it
   *  subscribes to in `register`, so the host no longer calls this. Kept so
   *  existing hooks keep compiling. */
  registerConnection(connectionId: string, service: string): void;
  /** Detach every subscription `register`/`registerConnection` took out, so
   * the host can swap in a replacement instance (e.g. after an app-keys
   * environment change) without double-handling inbound messages. A hook
   * without this method cannot be hot-swapped and stays live until restart. */
  unregister?(): void;
}

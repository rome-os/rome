export interface ChannelMessageHook {
  /** Subscribe to every channel in the deps' `channels` that can receive. The
   *  host calls this once; a channel's subscription follows whatever backs it,
   *  so the host never calls the hook again per Connection. */
  register(): Promise<void>;
  /** Detach every subscription `register` took out, so
   * the host can swap in a replacement instance (e.g. after an app-keys
   * environment change) without double-handling inbound messages. A hook
   * without this method cannot be hot-swapped and stays live until restart. */
  unregister?(): void;
}

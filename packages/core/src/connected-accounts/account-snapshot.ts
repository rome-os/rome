/**
 * The read-sharing half of an address book, for a channel that folds its
 * whole address book on every call.
 *
 * An `Accounts` consumer usually needs several answers about the same mirror
 * at once — a listing, and a `resolve` for each address it already holds — and
 * each is its own call. Wrapping the fold here makes those one read of one
 * mirror, so the answers cannot describe address books a sync moved between,
 * and a caller that asks for all of them pays for one.
 *
 * This is not a cache. The shared window closes the moment the read settles, so
 * nothing outlives a sync and no invalidation is owed. A channel that wants to
 * stop re-reading per call wants a real cache, and that belongs in the channel,
 * where a sync can invalidate it.
 */
export function sharedRead<T>(read: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const started = read();
    inFlight = started;
    const settled = () => {
      if (inFlight === started) inFlight = null;
    };
    started.then(settled, settled);
    return started;
  };
}

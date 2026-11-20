import { useEffect } from "react";

// Every part of this page that is waiting on an upgrade it knows of: the
// sidebar's or Settings' own request, or the nightly banner's restart. The
// chat reads it to name an outage an upgrade only when one is under way.
const holders = new Set<symbol>();

/** Whether this page knows an upgrade of Rome is under way. */
export function isUpgradeUnderWay(): boolean {
  return holders.size > 0;
}

/** Marks an upgrade under way for as long as `active` holds and the caller is mounted. */
export function useUpgradeUnderWay(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const holder = Symbol("upgrade");
    holders.add(holder);
    return () => {
      holders.delete(holder);
    };
  }, [active]);
}

import { useRef } from "react";

function sameEntries<K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (!b.has(key) || b.get(key) !== value) return false;
  return true;
}

/**
 * `map`, or the map this returned before when it holds the same entries. For a
 * map that is rebuilt from scratch on every change to its source, so what it is
 * passed to can be memoized while its contents stand.
 */
export function useStableMap<M extends ReadonlyMap<unknown, unknown>>(map: M): M {
  const kept = useRef(map);
  if (kept.current !== map && !sameEntries(kept.current, map)) kept.current = map;
  return kept.current;
}

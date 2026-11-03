import { useEffect, useState } from "react";
import { getSession } from "@/lib/chat-api";
import { useSessionsChanged } from "@/lib/session-events";

/**
 * Names of the given chat sessions, keyed by session id, for labelling the
 * side-chat tabs. Re-read whenever the set of ids changes or a session changes
 * (a rename, or a new chat getting its title). A session that is unnamed, gone,
 * or not loaded yet has no entry, so the caller keeps its generic label. A
 * failed read keeps the name already shown.
 */
export function useSessionNames(sessionIds: readonly string[]): ReadonlyMap<string, string> {
  const key = [...new Set(sessionIds)].sort().join("\n");
  const [names, setNames] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [generation, setGeneration] = useState(0);
  useSessionsChanged(() => setGeneration((value) => value + 1));

  useEffect(() => {
    const ids = key ? key.split("\n") : [];
    if (ids.length === 0) return;
    let cancelled = false;
    void Promise.all(
      ids.map((id) =>
        getSession(id).then(
          (session) => [id, session?.name.trim() ?? ""] as const,
          () => [id, null] as const,
        ),
      ),
    ).then((results) => {
      if (cancelled) return;
      setNames((previous) => {
        const next = new Map(previous);
        for (const [id, name] of results) {
          if (name === null) continue;
          if (name) next.set(id, name);
          else next.delete(id);
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [key, generation]);

  return names;
}

// Which of the main timeline's thread stacks the reader can see now
// (docs/domains/chats.md#chat-thread).

import { useEffect, useState } from "react";

const NONE: ReadonlySet<string> = new Set();

/**
 * The roots, among `roots`, whose stack is at least half inside `scroller`'s
 * view. `content` holds the stacks. Seeing a stack reads nothing: the set only
 * says which pills would say what the reader already sees. Without an
 * IntersectionObserver the set is empty, and every pill shows.
 */
export function useVisibleStacks(
  scroller: HTMLElement | null,
  content: HTMLElement | null,
  roots: readonly string[],
): ReadonlySet<string> {
  const [visible, setVisible] = useState<ReadonlySet<string>>(NONE);
  // A new list of the same roots watches the same stacks.
  const key = roots.join("\n");
  useEffect(() => {
    if (!scroller || !content || key === "" || typeof IntersectionObserver === "undefined") {
      setVisible(NONE);
      return;
    }
    const watched = new Set(key.split("\n"));
    const seen = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const root = (entry.target as HTMLElement).dataset.threadStack;
          if (root === undefined) continue;
          if (entry.intersectionRatio >= 0.5) seen.add(root);
          else seen.delete(root);
        }
        setVisible(new Set(seen));
      },
      { root: scroller, threshold: [0, 0.5, 1] },
    );
    for (const stack of content.querySelectorAll<HTMLElement>("[data-thread-stack]")) {
      if (watched.has(stack.dataset.threadStack ?? "")) observer.observe(stack);
    }
    return () => {
      observer.disconnect();
      setVisible(NONE);
    };
  }, [scroller, content, key]);
  return visible;
}

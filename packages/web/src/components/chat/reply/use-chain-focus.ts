// Opening a reply's chain in place from its quote (docs/domains/chats.md#chat-thread).
// The chain is a layer over the chat: the main transcript stays mounted under
// it, so closing needs no scroll restore. The message the reader pressed stays
// where it is on screen, and the chat changes in one view transition.

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { getThreadPage } from "@/lib/chat-api";
import { mergeChatMessage, prependChatMessages } from "@/lib/chat-message-merge";
import type { ChatMessage } from "@/lib/chat-types";
import { findMessageAnchor } from "./reply-source";

/** Messages each side of the pressed one that open the chain, and per page after. */
export const OPEN_LIMIT = 10;
export const PAGE_LIMIT = 20;

/** The chain in focus: the window of it that is loaded, oldest first. */
export interface ChainFocus {
  /** The id of the chain's root message. */
  root: string;
  /** The message that was pressed, which names the chain to the server for the whole focus. */
  anchor: string;
  messages: ChatMessage[];
  hasOlder: boolean;
  hasNewer: boolean;
  fetchedThrough?: string;
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> };
};

const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

const NAME = "view-transition-name";

/**
 * Gives the bubbles of `root` that are on screen the transition names the old
 * and the new picture share: one per bubble, by its message and its place in
 * it. With `ids`, only the bubbles of those messages.
 */
function nameBubbles(root: HTMLElement, ids: ReadonlySet<string> | null): HTMLElement[] {
  const view = root.getBoundingClientRect();
  const seen = new Map<string, number>();
  const named: HTMLElement[] = [];
  for (const bubble of root.querySelectorAll<HTMLElement>("[data-message-part]")) {
    const id = bubble.dataset.messagePart ?? "";
    const nth = seen.get(id) ?? 0;
    seen.set(id, nth + 1);
    const rect = bubble.getBoundingClientRect();
    if ((ids && !ids.has(id)) || rect.bottom < view.top || rect.top > view.bottom) continue;
    bubble.style.setProperty(NAME, `tm-${id.replace(/[^\w-]/g, "_")}-${nth}`);
    named.push(bubble);
  }
  return named;
}

/**
 * Makes `update` as one view transition: what is named in the old picture
 * (`nameOld`) and in the new one (`nameNew`, after the update) glides from one
 * place to the other, the rest fades. The names go when it ends. Without view
 * transitions, or with reduced motion, the update is at once.
 */
async function swap(
  scroller: HTMLElement,
  update: () => void,
  nameOld: () => HTMLElement[],
  nameNew: () => HTMLElement[],
) {
  const start = (document as ViewTransitionDocument).startViewTransition?.bind(document);
  if (!start || reducedMotion()) {
    update();
    return;
  }
  const named = nameOld();
  const root = document.documentElement;
  root.dataset.chainTransition = "";
  const surface = scroller.closest<HTMLElement>("[data-chat-surface]");
  if (surface) surface.dataset.chainActive = "";
  const motion = start(() => {
    for (const bubble of named.splice(0)) bubble.style.removeProperty(NAME);
    update();
    named.push(...nameNew());
  });
  await motion.finished.catch(() => {});
  for (const bubble of named) bubble.style.removeProperty(NAME);
  delete root.dataset.chainTransition;
  if (surface) delete surface.dataset.chainActive;
}

const px = (el: HTMLElement | null) => el?.offsetHeight ?? 0;
const setBlank = (el: HTMLElement | null, height: number) => {
  if (el) el.style.height = height > 0.5 ? `${height}px` : "";
};

/**
 * Scrolls `layer` so message `id` is `y` below its top. When there is not
 * enough above it, the rest is blank at the top, and when not enough below,
 * blank at the bottom.
 */
function place(layer: HTMLElement, id: string, y: number) {
  const anchor = findMessageAnchor(layer, id);
  if (!anchor) return;
  const top = layer.querySelector<HTMLElement>("[data-chain-top]");
  const bottom = layer.querySelector<HTMLElement>("[data-chain-bottom]");
  const content = layer.querySelector<HTMLElement>("[data-chain-content]");
  if (!content) return;
  setBlank(top, 0);
  setBlank(bottom, 0);
  layer.scrollTop = 0;
  const origin = layer.getBoundingClientRect().top;
  const diff = anchor.getBoundingClientRect().top - origin - y;
  setBlank(top, -diff);
  const want = Math.max(diff, 0);
  // scrollHeight is at least the viewport height, even for a short chain.
  // Use the real content end, with nonflexing spacers, to make room to scroll.
  const end = content.getBoundingClientRect().bottom - origin;
  setBlank(bottom, want + layer.clientHeight - end);
  layer.scrollTop = want;
}

const edgeIds = (messages: ChatMessage[]) => {
  const said = messages.filter((message) => message.role !== "trace");
  return { first: said[0]?.id, last: said[said.length - 1]?.id };
};

/**
 * The reply chain a Concierge chat is focused on. `scroller` is the chat's
 * message scroller, and `layer` goes on the layer's own. A quote that cannot
 * open its chain, because the server has none, goes to `fallback`, the jump to
 * the original.
 */
export function useChainFocus({
  sessionId,
  scroller,
  fallback,
}: {
  sessionId: string | null;
  scroller: HTMLElement | null;
  fallback: (quoted: string) => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<ChainFocus | null>(null);
  const latest = useRef({ focus, sessionId, scroller, fallback });
  latest.current = { focus, sessionId, scroller, fallback };
  // A motion or a page read runs.
  const busy = useRef(false);
  const reading = useRef(false);
  const afterRead = useRef<(() => void) | null>(null);
  const epoch = useRef(0);
  useEffect(() => {
    setFocus(null);
    return () => {
      epoch.current += 1;
    };
  }, [sessionId]);

  /** Opens the chain of message `from`, which carries the quote of `quoted`. */
  const open = useCallback(async (quoted: string, from: string) => {
    const { focus, sessionId, scroller, fallback } = latest.current;
    if (!scroller || !sessionId || busy.current || focus) return;
    busy.current = true;
    const openedAt = epoch.current;
    const pressed = findMessageAnchor(scroller, from);
    const y = pressed
      ? pressed.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      : 0;
    try {
      const page = await getThreadPage(sessionId, from, { limit: OPEN_LIMIT }).catch(() => null);
      if (openedAt !== epoch.current || latest.current.sessionId !== sessionId) return;
      if (!page) return fallback(quoted);
      const next = {
        root: page.messages.find((message) => message.id === from)?.chatThreadId ?? from,
        anchor: from,
        fetchedThrough: edgeIds(page.messages).last,
        ...page,
      };
      const ids = new Set(page.messages.map((message) => message.id));
      await swap(
        scroller,
        () => {
          flushSync(() => setFocus(next));
          if (layer.current) place(layer.current, from, y);
        },
        () => nameBubbles(scroller, ids),
        () => (layer.current ? nameBubbles(layer.current, null) : []),
      );
    } finally {
      busy.current = false;
    }
  }, []);

  const close = useCallback(async () => {
    const { focus, scroller } = latest.current;
    if (!focus || !scroller || busy.current) return;
    busy.current = true;
    try {
      const ids = new Set(focus.messages.map((message) => message.id));
      await swap(
        scroller,
        () => flushSync(() => setFocus(null)),
        () => (layer.current ? nameBubbles(layer.current, null) : []),
        () => nameBubbles(scroller, ids),
      );
    } finally {
      busy.current = false;
    }
  }, []);

  /** Reads the next `limit` messages above or below the loaded ones, keeping the view where it is. */
  const more = useCallback(async (side: "before" | "after", confirmedCursor?: string) => {
    const { focus, sessionId } = latest.current;
    if (!focus || !sessionId || reading.current) return;
    const { first, last } = edgeIds(focus.messages);
    const cursor = confirmedCursor ?? (side === "before" ? first : last);
    if (!cursor) return;
    reading.current = true;
    try {
      const page = await getThreadPage(sessionId, focus.anchor, {
        limit: PAGE_LIMIT,
        [side]: cursor,
      }).catch(() => null);
      const el = layer.current;
      if (!page || !el || latest.current.focus?.anchor !== focus.anchor) return;
      const was = { top: el.scrollTop, height: el.scrollHeight };
      flushSync(() =>
        setFocus(
          (held) =>
            held && {
              ...held,
              messages:
                side === "before"
                  ? prependChatMessages(held.messages, page.messages)
                  : (() => {
                      const split = held.messages.findIndex((message) => message.id === cursor) + 1;
                      const unlisted = (message: ChatMessage) =>
                        !page.messages.some((next) => next.id === message.id);
                      return [
                        ...held.messages.slice(0, split).filter(unlisted),
                        ...page.messages,
                        ...held.messages.slice(split).filter(unlisted),
                      ];
                    })(),
              ...(side === "after"
                ? { fetchedThrough: edgeIds(page.messages).last ?? held.fetchedThrough }
                : {}),
              ...(side === "before" ? { hasOlder: page.hasOlder } : { hasNewer: page.hasNewer }),
            },
        ),
      );
      if (side === "after") return;
      // The messages went in above what is read. The blank kept above is
      // given back first, then the scroll moves, so the same message stays put.
      const added = el.scrollHeight - was.height;
      const top = el.querySelector<HTMLElement>("[data-chain-top]");
      const take = Math.min(px(top), added + was.top);
      setBlank(top, px(top) - take);
      el.scrollTop = was.top + added - take;
      // What the blank below gives to growth is not for this.
      const bottom = el.querySelector<HTMLElement>("[data-chain-bottom]");
      setBlank(bottom, px(bottom) + added);
    } finally {
      reading.current = false;
      const pending = afterRead.current;
      afterRead.current = null;
      pending?.();
    }
  }, []);

  /**
   * A message that arrives live. One of the chain joins it while its window
   * holds the newest end, and else is picked up by scrolling down. One already
   * held is replaced where it stands.
   */
  const onLive = useCallback((message: ChatMessage) => {
    setFocus((held) => {
      if (!held) return held;
      const known = held.messages.some((m) => m.id === message.id);
      const traceOfChain =
        message.role === "trace" &&
        message.turnId != null &&
        held.messages.some((held) => held.turnId === message.turnId);
      if (!known && ((message.chatThreadId !== held.root && !traceOfChain) || held.hasNewer))
        return held;
      return { ...held, messages: mergeChatMessage(held.messages, message) };
    });
  }, []);

  const reconcile: () => Promise<void> = useCallback(async () => {
    if (reading.current) {
      afterRead.current = () => {
        const held = latest.current.focus;
        if (held && !held.hasNewer)
          void more("after", held.fetchedThrough ?? edgeIds(held.messages).last);
      };
      return;
    }
    const held = latest.current.focus;
    if (held && !held.hasNewer)
      await more("after", held.fetchedThrough ?? edgeIds(held.messages).last);
  }, [more]);

  const onPage = useCallback(
    (messages: ChatMessage[]) => {
      const current = latest.current.focus;
      if (current && !current.hasNewer) {
        const known = new Set(current.messages.map((message) => message.id));
        const at = messages.findIndex((message) => message.id === edgeIds(current.messages).last);
        if (
          messages.some(
            (message, index) =>
              message.chatThreadId === current.root &&
              !known.has(message.id) &&
              (at < 0 || index <= at),
          )
        ) {
          void more("after", current.fetchedThrough ?? edgeIds(current.messages).last);
        }
      }
      setFocus((held) => {
        if (!held) return held;
        const byId = new Map(messages.map((message) => [message.id, message]));
        let next = held.messages.map((message) => byId.get(message.id) ?? message);
        const last = held.messages.filter((message) => message.role !== "trace").at(-1);
        const at = last ? messages.findIndex((message) => message.id === last.id) : -1;
        if (!held.hasNewer && at >= 0) {
          for (const message of messages.slice(at + 1)) {
            const traceOfChain =
              message.role === "trace" &&
              message.turnId != null &&
              next.some((held) => held.turnId === message.turnId);
            if (message.chatThreadId === held.root || traceOfChain)
              next = mergeChatMessage(next, message);
          }
        }
        return { ...held, messages: next };
      });
    },
    [more],
  );

  const focused = focus !== null;
  // Esc closes the focus, unless what has focus used the key first.
  useEffect(() => {
    if (!focused) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) void close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [focused, close]);

  return { focus, layer, open, close, more, onLive, onPage, reconcile };
}

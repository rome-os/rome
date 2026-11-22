// Opening a reply's chain in place from its quote (docs/domains/chats.md#chat-thread).
// The chain is a layer over the chat: the main transcript stays mounted under
// it, so closing needs no scroll restore. The message the reader pressed stays
// where it is on screen, and only the message list changes in one native scoped view transition.

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ChatApiError, getThreadPage } from "@/lib/chat-api";
import {
  mergeChatMessage,
  mergeLatestMessagePage,
  prependChatMessages,
} from "@/lib/chat-message-merge";
import type { ChatMessage } from "@/lib/chat-types";
import { findMessageAnchor } from "./reply-source";

/** Messages each side of the pressed one that open the chain, and per page after. */
export const OPEN_LIMIT = 10;
export const PAGE_LIMIT = 20;

/** The chain in focus: the window of it that is loaded, oldest first. */
export interface ChainFocus {
  /** The id of the chain's root message. */
  root: string;
  sessionId: string;
  /** Paging is unknown until the anchor read succeeds. */
  initial?: "loading" | "error";
  /** The message that was pressed, which names the chain to the server for the whole focus. */
  anchor: string;
  messages: ChatMessage[];
  hasOlder: boolean;
  hasNewer: boolean;
  fetchedThrough?: string;
}

type TransitionElement = HTMLElement & {
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
  root: HTMLElement | null,
  update: () => void,
  nameOld: () => HTMLElement[],
  nameNew: () => HTMLElement[],
) {
  const start = (root as TransitionElement | null)?.startViewTransition?.bind(root);
  if (!root || !start || reducedMotion()) {
    update();
    return;
  }
  const named = nameOld();
  root.dataset.chainTransition = "";
  const motion = start(() => {
    for (const bubble of named.splice(0)) bubble.style.removeProperty(NAME);
    update();
    named.push(...nameNew());
  });
  await motion.finished.catch(() => {});
  for (const bubble of named) bubble.style.removeProperty(NAME);
  delete root.dataset.chainTransition;
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

/** The loaded chain, retaining the chat's server order and its turns' trace context. */
function memoryChain(messages: ChatMessage[], root: string, anchor: string) {
  const belongs = (message: ChatMessage) =>
    message.role !== "trace" &&
    (message.chatThreadId === root || message.id === root || message.id === anchor);
  const turns = new Set(
    messages
      .filter(belongs)
      .map((message) => message.turnId)
      .filter(Boolean),
  );
  return messages.filter((message) =>
    message.role === "trace" ? !!message.turnId && turns.has(message.turnId) : belongs(message),
  );
}

/** Keeps the first message being read in place while rows above or inside it change. */
function keepReading(
  el: HTMLElement | null,
  fallback: { id: string; y: number },
  update: () => void,
) {
  let anchor = fallback;
  if (el) {
    const view = el.getBoundingClientRect();
    const pressed = findMessageAnchor(el, fallback.id);
    const stillPinned =
      pressed && Math.abs(pressed.getBoundingClientRect().top - view.top - fallback.y) < 1;
    const clear = view.top + (Number.parseFloat(getComputedStyle(el).scrollPaddingTop) || 0);
    for (const row of stillPinned
      ? []
      : el.querySelectorAll<HTMLElement>("[data-timeline-anchor]")) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > clear && rect.top < view.bottom) {
        anchor = { id: row.dataset.timelineAnchor!.split(" ")[0], y: rect.top - view.top };
        break;
      }
    }
  }
  update();
  if (el) place(el, anchor.id, anchor.y);
}

interface Opening {
  token: number;
  sessionId: string;
  anchor: string;
  quoted: string;
  root: string;
  y: number;
  motion: Promise<void>;
  pending: boolean;
  refresh: boolean;
  // Live updates received after the request began must not yield to its older snapshot.
  updates: Map<string, ChatMessage>;
}

/**
 * The reply chain a Concierge chat is focused on. `scroller` is the chat's
 * message scroller, and `layer` goes on the layer's own. A quote that cannot
 * open its chain, because the server has none, goes to `fallback`, the jump to
 * the original.
 */
export function useChainFocus({
  sessionId,
  scroller,
  messages,
  fallback,
}: {
  sessionId: string | null;
  scroller: HTMLElement | null;
  messages: ChatMessage[];
  fallback: (quoted: string) => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const scope = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<ChainFocus | null>(null);
  const current = focus?.sessionId === sessionId ? focus : null;
  const latest = useRef({ focus: current, sessionId, scroller, messages, fallback });
  latest.current = { focus: current, sessionId, scroller, messages, fallback };
  // Only an animation locks close. A network read never does.
  const busy = useRef<number | null>(null);
  const reading = useRef(false);
  const afterRead = useRef<(() => void) | null>(null);
  const epoch = useRef(0);
  const opening = useRef<Opening | null>(null);
  useEffect(() => {
    setFocus(null);
    reading.current = false;
    opening.current = null;
    afterRead.current = null;
    return () => {
      epoch.current += 1;
    };
  }, [sessionId]);

  const close = useCallback(async () => {
    const { focus, scroller } = latest.current;
    if (!focus || !scroller || busy.current !== null) return;
    const token = ++epoch.current;
    opening.current = null;
    reading.current = false;
    afterRead.current = null;
    busy.current = token;
    try {
      const ids = new Set(focus.messages.map((message) => message.id));
      await swap(
        scope.current,
        () => flushSync(() => setFocus(null)),
        () => (layer.current ? nameBubbles(layer.current, null) : []),
        () => nameBubbles(scroller, ids),
      );
    } finally {
      if (busy.current === token) busy.current = null;
    }
  }, []);

  /** Reads the next `limit` messages above or below the loaded ones, keeping the view where it is. */
  const more = useCallback(async (side: "before" | "after", confirmedCursor?: string) => {
    const { focus, sessionId } = latest.current;
    if (!focus || focus.initial || !sessionId || reading.current) return;
    const token = epoch.current;
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
      if (!page || !el || token !== epoch.current || latest.current.sessionId !== sessionId) return;
      const was = { top: el.scrollTop, height: el.scrollHeight };
      flushSync(() =>
        setFocus(
          (held) =>
            held && {
              ...held,
              messages: (() => {
                let messages =
                  side === "before"
                    ? prependChatMessages(held.messages, page.messages)
                    : (() => {
                        const split =
                          held.messages.findIndex((message) => message.id === cursor) + 1;
                        const unlisted = (message: ChatMessage) =>
                          !page.messages.some((next) => next.id === message.id);
                        return [
                          ...held.messages.slice(0, split).filter(unlisted),
                          ...page.messages,
                          ...held.messages.slice(split).filter(unlisted),
                        ];
                      })();
                if (side === "after" && !page.hasNewer) {
                  for (const message of opening.current?.updates.values() ?? [])
                    messages = mergeChatMessage(messages, message);
                }
                return messages;
              })(),
              ...(side === "after"
                ? { fetchedThrough: edgeIds(page.messages).last ?? held.fetchedThrough }
                : {}),
              ...(side === "before" ? { hasOlder: page.hasOlder } : { hasNewer: page.hasNewer }),
            },
        ),
      );
      if (side === "after") {
        if (!page.hasNewer) opening.current?.updates.clear();
        return;
      }
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
      if (token === epoch.current) {
        reading.current = false;
        const pending = afterRead.current;
        afterRead.current = null;
        pending?.();
      }
    }
  }, []);

  const readInitial = useCallback(
    async (job: Opening) => {
      if (job.pending) return;
      job.pending = true;
      // A retry's snapshot supersedes updates already displayed before that read.
      for (const id of job.updates.keys()) {
        if (latest.current.focus?.messages.some((message) => message.id === id))
          job.updates.delete(id);
      }
      const valid = () =>
        opening.current === job &&
        epoch.current === job.token &&
        latest.current.sessionId === job.sessionId;
      try {
        const page = await getThreadPage(job.sessionId, job.anchor, { limit: OPEN_LIMIT });
        await job.motion;
        if (!valid()) return;
        if (!page) {
          epoch.current += 1;
          opening.current = null;
          flushSync(() => setFocus(null));
          latest.current.fallback(job.quoted);
          return;
        }
        keepReading(layer.current, { id: job.anchor, y: job.y }, () => {
          flushSync(() =>
            setFocus((held) => {
              if (!held) return held;
              let messages = mergeLatestMessagePage(held.messages, page.messages);
              for (const message of job.updates.values()) {
                if (!page.hasNewer || messages.some((held) => held.id === message.id))
                  messages = mergeChatMessage(messages, message);
              }
              return {
                ...held,
                root:
                  page.messages.find((message) => message.id === job.anchor)?.chatThreadId ??
                  held.root,
                messages,
                initial: undefined,
                hasOlder: page.hasOlder,
                hasNewer: page.hasNewer,
                fetchedThrough: edgeIds(page.messages).last,
              };
            }),
          );
        });
        for (const id of job.updates.keys()) {
          if (latest.current.focus?.messages.some((message) => message.id === id))
            job.updates.delete(id);
        }
      } catch (error) {
        await job.motion;
        if (!valid()) return;
        if (error instanceof ChatApiError && (error.status === 401 || error.status === 403)) {
          epoch.current += 1;
          opening.current = null;
          flushSync(() => setFocus(null));
          latest.current.fallback(job.quoted);
        } else {
          setFocus((held) => held && { ...held, initial: "error" });
        }
      } finally {
        job.pending = false;
        if (valid() && !latest.current.focus?.initial && job.refresh) {
          job.refresh = false;
          void more("after", latest.current.focus?.fetchedThrough);
        }
      }
    },
    [more],
  );

  /** Opens immediately from loaded messages while the anchor read runs in parallel. */
  const open = useCallback(
    async (quoted: string, from: string) => {
      const { focus, sessionId, scroller, messages } = latest.current;
      if (!scroller || !sessionId || busy.current !== null || focus) return;
      const token = ++epoch.current;
      busy.current = token;
      const pressed = findMessageAnchor(scroller, from);
      const y = pressed
        ? pressed.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        : 0;
      const root = messages.find((message) => message.id === from)?.chatThreadId ?? from;
      const local = memoryChain(messages, root, from);
      const job: Opening = {
        token,
        sessionId,
        anchor: from,
        quoted,
        root,
        y,
        motion: Promise.resolve(),
        pending: false,
        refresh: false,
        updates: new Map(),
      };
      opening.current = job;
      const next: ChainFocus = {
        sessionId,
        root,
        anchor: from,
        messages: local,
        initial: "loading",
        hasOlder: true,
        hasNewer: true,
      };
      const ids = new Set(local.map((message) => message.id));
      try {
        job.motion = swap(
          scope.current,
          () => {
            if (epoch.current !== token || latest.current.sessionId !== sessionId) return;
            flushSync(() => setFocus(next));
            if (layer.current) place(layer.current, from, y);
          },
          () => nameBubbles(scroller, ids),
          () => (layer.current ? nameBubbles(layer.current, null) : []),
        );
        void readInitial(job);
        await job.motion;
      } finally {
        if (busy.current === token) busy.current = null;
      }
    },
    [readInitial],
  );

  const retry = useCallback(() => {
    const job = opening.current;
    if (!job || job.pending || latest.current.focus?.initial !== "error") return;
    setFocus((held) => held && { ...held, initial: "loading" });
    void readInitial(job);
  }, [readInitial]);

  /**
   * A message that arrives live. One of the chain joins it while its window
   * holds the newest end, and else is picked up by scrolling down. One already
   * held is replaced where it stands.
   */
  const onLive = useCallback((message: ChatMessage) => {
    const job = opening.current;
    if (job && (!latest.current.focus || latest.current.focus.initial)) {
      const held = [...latest.current.messages, ...job.updates.values()];
      const traceOfChain =
        message.role === "trace" &&
        message.turnId != null &&
        held.some((row) => row.chatThreadId === job.root && row.turnId === message.turnId);
      if (
        latest.current.focus?.messages.some((row) => row.id === message.id) ||
        message.chatThreadId === job.root ||
        message.id === job.root ||
        traceOfChain
      )
        job.updates.set(message.id, message);
    }
    setFocus((held) => {
      if (!held) return held;
      const known = held.messages.some((m) => m.id === message.id);
      const traceOfChain =
        message.role === "trace" &&
        message.turnId != null &&
        held.messages.some((held) => held.turnId === message.turnId);
      if (!known && message.chatThreadId !== held.root && !traceOfChain) return held;
      if (!known && (held.initial || held.hasNewer)) return held;
      return { ...held, messages: mergeChatMessage(held.messages, message) };
    });
  }, []);

  const reconcile: () => Promise<void> = useCallback(async () => {
    if (latest.current.focus?.initial) {
      if (opening.current) opening.current.refresh = true;
      return;
    }
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
      const job = opening.current;
      if (job && (!current || current.initial)) {
        const chain = memoryChain(messages, job.root, job.anchor);
        for (const message of messages) {
          if (current?.messages.some((row) => row.id === message.id) || chain.includes(message))
            job.updates.set(message.id, message);
        }
      }
      if (current && !current.initial && !current.hasNewer) {
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

  const focused = current !== null;
  // Esc closes the focus, unless what has focus used the key first.
  useEffect(() => {
    if (!focused) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) void close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [focused, close]);

  return { focus: current, layer, scope, open, close, more, retry, onLive, onPage, reconcile };
}

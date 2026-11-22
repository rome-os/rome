import { X } from "lucide-react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { ConciergeTranscript } from "@/components/chat/ConciergeTranscript";
import type { BlockActions } from "@/components/chat/MessageList";
import { type AgentIdentity, buildRows } from "@/components/chat/chat-view";
import { IconButton } from "@/components/ui/icon-button";
import { EMPTY_LIVE_TEXT } from "@/hooks/live-text";
import type { ChatMessage } from "@/lib/chat-types";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import { type ChainFocus } from "./use-chain-focus";
import { ReplyDraftProvider, type ReplyTarget, useReplyDraft } from "./reply-draft";
import { lastTextMessage, replyPreview } from "./reply-source";

/** How far from an edge of the layer the next page of the chain starts to load. */
const LOAD_AHEAD_PX = 800;

/** A click on one of these is theirs, not a click on blank space. */
const KEEP =
  "a,button,input,textarea,select,summary,label,[role=button],[role=link],[data-rmiz],[data-concierge-bubble-part],[data-chat-card],[data-chat-card-message]";

const noop = () => {};

/** What replying to `message` quotes: the whole of its text. */
function targetOf(message: ChatMessage): ReplyTarget {
  const text = parseMessageEntries(message)
    .flatMap((part) => (part.type === "text" && part.content.trim() ? [part.content] : []))
    .join("\n\n");
  return {
    messageId: message.id,
    author: message.role === "user" ? "guardian" : "agent",
    preview: replyPreview(text),
  };
}

/**
 * The reply chain in focus, as a layer over the chat's transcript, which stays
 * under it (docs/domains/chats.md#chat-thread). It draws the loaded window of
 * the chain with the chat's own messages, a quote in it is plain text, and the
 * chat's composer replies to the chain's last message with text.
 *
 * The scroller keeps blank above and below the messages when there are too
 * few to hold the pressed message where it was: the blank below is given to a
 * message that arrives, and the one above to the messages a page puts there.
 */
export function ChainFocusLayer({
  focus,
  layerRef,
  floor,
  identityBySession,
  identity,
  actions,
  onMore,
  onClose,
}: {
  focus: ChainFocus;
  layerRef: RefObject<HTMLDivElement | null>;
  /** The composer's floor, whose height the layer keeps clear at its bottom. */
  floor: HTMLElement | null;
  identityBySession: Map<string, AgentIdentity>;
  identity: AgentIdentity;
  actions: BlockActions;
  onMore: (side: "before" | "after") => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("chat");
  const draft = useReplyDraft();
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // A quote here is plain: its original is in the chain, right above.
  const plain = useMemo(() => (draft ? { ...draft, jump: undefined } : null), [draft]);
  const rows = useMemo(
    () =>
      buildRows(focus.messages, identityBySession, identity, {
        runningTurnId: null,
        isStreaming: false,
      }),
    [focus.messages, identityBySession, identity],
  );
  const live = useMemo(
    () => ({
      isStreaming: false,
      runningTurnId: null,
      snapshot: null,
      textStore: EMPTY_LIVE_TEXT,
      identity,
    }),
    [identity],
  );

  // The composer replies to the chain's last message with text. A reply the
  // reader picked instead stays until the chain has a newer one, and the
  // chain's own is dropped with the layer.
  const last = lastTextMessage(focus.messages);
  const lastRef = useRef(last);
  lastRef.current = last;
  const lastId = last?.id;
  const replying = draft?.target != null;
  const picked = useRef<string | null>(null);
  useEffect(() => {
    const message = lastRef.current;
    if (!message || (picked.current === message.id && replying)) return;
    picked.current = message.id;
    draftRef.current?.set(targetOf(message), { quiet: true });
  }, [lastId, replying]);
  useEffect(
    () => () => {
      const current = draftRef.current;
      if (picked.current !== null && current?.target?.messageId === picked.current) current.clear();
    },
    [],
  );

  const [floorHeight, setFloorHeight] = useState(floor?.offsetHeight ?? 0);
  useEffect(() => {
    if (!floor || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setFloorHeight(floor.offsetHeight));
    observer.observe(floor);
    return () => observer.disconnect();
  }, [floor]);

  // A message that arrives takes up the blank kept below the messages.
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = content.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let height = el.offsetHeight;
    const observer = new ResizeObserver(() => {
      const bottom = layerRef.current?.querySelector<HTMLElement>("[data-chain-bottom]");
      if (bottom && el.offsetHeight > height) {
        const blank = bottom.offsetHeight - (el.offsetHeight - height);
        bottom.style.height = blank > 0.5 ? `${blank}px` : "";
      }
      height = el.offsetHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [layerRef]);

  // Reads the next page when the view comes within reach of an end.
  const check = useCallback(() => {
    const el = layerRef.current;
    if (!el) return;
    const below = el.querySelector<HTMLElement>("[data-chain-bottom]")?.offsetHeight ?? 0;
    if (focus.hasOlder && el.scrollTop < LOAD_AHEAD_PX) onMore("before");
    if (focus.hasNewer && el.scrollHeight - below - el.scrollTop - el.clientHeight < LOAD_AHEAD_PX)
      onMore("after");
  }, [focus.hasOlder, focus.hasNewer, layerRef, onMore]);
  // After each page, in case the view is still at an end.
  useLayoutEffect(check, [check, focus.messages]);

  return (
    <div data-chain-layer className="absolute inset-0 z-5">
      <div
        ref={layerRef}
        onScroll={check}
        onClick={(event) => {
          if (window.getSelection()?.isCollapsed === false) return;
          if (!(event.target as Element).closest(KEEP)) onClose();
        }}
        className="scrollbar-hover-shown concierge-header-clear flex h-full flex-col overflow-y-auto overscroll-contain bg-chat-canvas"
      >
        <div data-chain-top aria-hidden className="shrink-0" />
        <div ref={content} className="flex flex-1 flex-col">
          <ReplyDraftProvider value={plain}>
            <ConciergeTranscript rows={rows} live={live} actions={actions} contentRef={noop} />
          </ReplyDraftProvider>
          <div aria-hidden className="shrink-0" style={{ height: floorHeight }} />
        </div>
        <div data-chain-bottom aria-hidden className="shrink-0" />
      </div>
      {/* Under the floating header, on the transcript's top-right corner. */}
      <div className="pointer-events-none absolute top-[calc(var(--rome-concierge-header-offset)+0.5rem)] right-3 z-10 md:right-6">
        <IconButton
          size="md"
          label={t("reply.closeChain")}
          icon={<X />}
          onClick={onClose}
          className="pointer-events-auto rounded-full border border-border bg-surface/95 text-muted-foreground shadow-10 backdrop-blur-md hover:text-foreground"
        />
      </div>
    </div>
  );
}

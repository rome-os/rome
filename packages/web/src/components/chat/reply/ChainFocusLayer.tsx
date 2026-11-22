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
import { Spinner } from "@rome-os/ui/spinner";
import { Button } from "@/components/ui/button";
import { ConciergeTranscript } from "@/components/chat/ConciergeTranscript";
import type { BlockActions } from "@/components/chat/MessageList";
import { type AgentIdentity, buildRows } from "@/components/chat/chat-view";
import { EMPTY_LIVE_TEXT } from "@/hooks/live-text";
import { type ChainFocus } from "./use-chain-focus";
import { ReplyDraftProvider, useReplyDraft } from "./reply-draft";

/** How far from an edge of the layer the next page of the chain starts to load. */
const LOAD_AHEAD_PX = 800;

/** A click on one of these is theirs, not a click on blank space. */
const KEEP =
  "a,button,input,textarea,select,summary,label,[role=button],[role=link],[data-rmiz],[data-concierge-bubble-part],[data-chat-card],[data-chat-card-message]";

const noop = () => {};

/**
 * The reply chain in focus, as a layer over the chat's transcript, which stays
 * under it (docs/domains/chats.md#chat-thread). It draws the loaded window of
 * the chain with the chat's own messages, a quote in it is plain text, and the
 * chat's composer sends to the chain without picking a reply draft.
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
  onRetry,
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
  onRetry: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("chat");
  const draft = useReplyDraft();
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

  const [floorHeight, setFloorHeight] = useState(floor?.offsetHeight ?? 0);
  useEffect(() => {
    if (!floor || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setFloorHeight(floor.offsetHeight));
    observer.observe(floor);
    return () => observer.disconnect();
  }, [floor]);

  // A message that arrives takes up the blank kept below the messages.
  const content = useRef<HTMLDivElement>(null);
  const contentHeight = useRef(0);
  const consumeBlank = useCallback(() => {
    const el = content.current;
    if (!el) return;
    const bottom = layerRef.current?.querySelector<HTMLElement>("[data-chain-bottom]");
    const height = el.offsetHeight;
    if (bottom && height !== contentHeight.current) {
      const blank = bottom.offsetHeight - (height - contentHeight.current);
      bottom.style.height = blank > 0.5 ? `${blank}px` : "";
    }
    contentHeight.current = height;
  }, [layerRef]);
  // Set the resize baseline in the commit, before an anchored backfill places
  // the list. Its later observer delivery must not consume the blank twice.
  useLayoutEffect(consumeBlank, [consumeBlank, focus.messages, floorHeight]);
  useEffect(() => {
    const el = content.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(consumeBlank);
    observer.observe(el);
    return () => observer.disconnect();
  }, [consumeBlank]);

  // Reads the next page when the view comes within reach of an end.
  const check = useCallback(() => {
    const el = layerRef.current;
    if (!el || focus.initial) return;
    const below = el.querySelector<HTMLElement>("[data-chain-bottom]")?.offsetHeight ?? 0;
    if (focus.hasOlder && el.scrollTop < LOAD_AHEAD_PX) onMore("before");
    if (focus.hasNewer && el.scrollHeight - below - el.scrollTop - el.clientHeight < LOAD_AHEAD_PX)
      onMore("after");
  }, [focus.initial, focus.hasOlder, focus.hasNewer, layerRef, onMore]);
  // After each page, in case the view is still at an end.
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [check, focus.messages]);

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
        <div ref={content} data-chain-content className="flex shrink-0 flex-col">
          <ReplyDraftProvider value={plain}>
            <ConciergeTranscript rows={rows} live={live} actions={actions} contentRef={noop} />
          </ReplyDraftProvider>
          <div aria-hidden className="shrink-0" style={{ height: floorHeight }} />
        </div>
        <div data-chain-bottom aria-hidden className="shrink-0" />
      </div>
      {focus.initial ? (
        <div
          data-chain-load={focus.initial}
          className="absolute inset-x-0 flex justify-center"
          style={{ bottom: floorHeight + 16 }}
        >
          <div
            role="status"
            className="flex items-center gap-2 rounded-8 bg-chat-canvas px-3 py-1 text-aux text-muted-foreground"
          >
            {focus.initial === "loading" ? (
              <Spinner size="sm" label={t("reply.loadingChain")} />
            ) : (
              <>
                <span>{t("reply.loadFailed")}</span>
                <Button variant="ghost" size="sm" onClick={onRetry}>
                  {t("reply.retry")}
                </Button>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

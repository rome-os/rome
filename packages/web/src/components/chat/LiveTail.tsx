import { memo } from "react";
import { renderFlatEntries } from "@/components/chat/entries";
import { LiveTurnActivity } from "@/components/chat/LiveTurnActivity";
import type { BlockActions, LivePreview } from "@/components/chat/MessageList";
import { useLiveText } from "@/hooks/live-text";
import { useSmoothText } from "@/hooks/use-smooth-text";

/** The key the typing bubble pops in under: it pops in again after each text block. */
function typingEntranceKey(live: LivePreview): string {
  return `${live.runningTurnId ?? "no-turn"}:typing:${live.textThroughOrdinal ?? -1}`;
}

// The end of the running turn's row once its text is known.
function Tail({ live, actions, text }: { live: LivePreview; actions: BlockActions; text: string }) {
  return (
    <>
      {text ? (
        // rome-live-caret appends the pulsing live dot after the last rendered
        // character (see globals.css).
        <div className="rome-live-caret">
          {renderFlatEntries([{ type: "text", content: text, blockIx: live.blockIx ?? 0 }], {
            ...actions,
            turnId: live.runningTurnId ?? undefined,
            transcript: { live: true },
          })}
        </div>
      ) : null}
      <LiveTurnActivity
        snapshot={live.snapshot}
        textThroughOrdinal={live.textThroughOrdinal}
        hasText={!!text}
        entranceKey={typingEntranceKey(live)}
      />
    </>
  );
}

// The server sends text in provider-sized chunks, so showing each as it comes
// makes the bubble jump. This reveals it a few characters a frame instead, and
// the reveal's state is why the component that follows the text is this one.
function TypedTail({ live, actions }: { live: LivePreview; actions: BlockActions }) {
  const { key, text: delivered } = useLiveText(live.textStore);
  const text = useSmoothText(delivered, key);
  return <Tail live={live} actions={actions} text={text} />;
}

function InstantTail({ live, actions }: { live: LivePreview; actions: BlockActions }) {
  const { text } = useLiveText(live.textStore);
  return <Tail live={live} actions={actions} text={text} />;
}

/**
 * The end of the running turn's row: the text block being typed, then the
 * typing bubble or the step the agent is on. The text arrives many times a
 * second, so this is the one component that follows it; the chat and the
 * finished rows around it do not render for it.
 */
export const LiveTail = memo(function LiveTail(props: {
  live: LivePreview;
  actions: BlockActions;
}) {
  return props.live.textStore.instant ? <InstantTail {...props} /> : <TypedTail {...props} />;
});

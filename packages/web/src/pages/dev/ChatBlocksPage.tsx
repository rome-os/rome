/**
 * Gallery of the transcript blocks, at `/dev/chat-blocks`.
 *
 * A block renders only once an agent reaches a particular state — a parked
 * turn, a pending approval, a handoff — and `/chat` opens on an empty composer,
 * so no product route shows one on load. This page is where the family becomes
 * reachable to a reader and to the layout-invariant sweep.
 *
 * A specimen goes through `renderSingleBlock` rather than mounting its
 * component, so it exercises the dispatch guards too: a block shape that stops
 * reaching its component fails here rather than rendering a component nothing
 * produces.
 *
 * A specimen must render the same on every load. `e2e/layout-invariants.spec.ts`
 * sweeps this route with `retries: 0`, so a block that fetches on mount,
 * animates, or reads the clock needs a frozen fixture before it belongs here.
 */

import type { StreamBlock } from "@/lib/chat-types";
import { interactionResultKey } from "@/components/chat/chat-view";
import { renderSingleBlock, type RenderBlockOptions } from "@/components/chat/blocks/render";

/** Specimens are inert data; submissions have nowhere to go on this page. */
const noop = () => {};

const SESSION_ID = "dev-chat-blocks";

/**
 * A pending `ask_question` card. `appId` is the "core" sentinel and `builtin`
 * is what routes it to rome-web's own QuestionCard instead of an app bundle.
 */
const askQuestion = (toolUseId: string, questions: unknown[]): StreamBlock => ({
  type: "pending_interaction",
  toolUseId,
  appId: "core",
  render: { kind: "inline", componentId: "question-card", builtin: true, props: { questions } },
});

interface Specimen {
  id: string;
  title: string;
  /** What this specimen is for — the state or layout branch it pins. */
  note: string;
  block: StreamBlock;
  /** Prior submitted output, for a specimen of the resolved (locked) card. */
  result?: Record<string, unknown>;
}

export const CHAT_BLOCK_SPECIMENS: Specimen[] = [
  {
    id: "question-card-compact",
    title: "QuestionCard — compact options",
    note: "Every option is short, so the chips and the free-text field share one wrapped row. This is the branch where a Control-member height disagreement shows up.",
    block: askQuestion("dev-ask-compact", [
      {
        id: "tone",
        question: "How should the rewrite read?",
        type: "single",
        options: ["Warm", "Plain", "Playful"],
        freeText: true,
      },
    ]),
  },
  {
    id: "question-card-stacked",
    title: "QuestionCard — stacked options",
    note: "One option passes the 32-character threshold, so every option becomes a full-width wrapping row and the free-text field goes below them rather than beside.",
    block: askQuestion("dev-ask-stacked", [
      {
        id: "keep",
        question: "What should the new opening keep?",
        type: "multi",
        options: [
          "The line about not holding it all in your head",
          "The pricing note",
          "The beta thank-you",
        ],
        freeText: true,
      },
    ]),
  },
  {
    id: "question-card-wrapped",
    title: "QuestionCard — wrapped option",
    note: "An option long enough to take two lines. The card's only control that is not a fixed step: it holds the sm floor on one line and grows past it here.",
    block: askQuestion("dev-ask-wrapped", [
      {
        id: "opening",
        question: "Which opening should the rewrite use?",
        type: "single",
        options: [
          "Open on what the reader stops doing once Rome is running, rather than on anything we shipped this quarter",
          "Open on the waitlist itself",
        ],
      },
    ]),
  },
  {
    id: "question-card-text",
    title: "QuestionCard — free-text question",
    note: "The Textarea branch, and the one question kind that may be left blank without blocking Send.",
    block: askQuestion("dev-ask-text", [
      { id: "avoid", question: "Anything to avoid?", type: "text", optional: true },
    ]),
  },
  {
    id: "question-card-resolved",
    title: "QuestionCard — resolved",
    note: "Answered through the card: the fieldset is disabled, the actions are gone, and the footer reads back the outcome.",
    block: askQuestion("dev-ask-resolved", [
      {
        id: "tone",
        question: "How should the rewrite read?",
        type: "single",
        options: ["Warm", "Plain", "Playful"],
        freeText: true,
      },
    ]),
    result: { answers: [{ questionId: "tone", value: "Warm" }] },
  },
];

export default function ChatBlocksGalleryPage() {
  return (
    <div className="min-h-screen bg-background p-8">
      <div className="mx-auto max-w-5xl space-y-10">
        <div>
          <h1 className="font-serif text-display text-foreground">Transcript blocks</h1>
          <p className="mt-1 max-w-2xl text-ui text-muted-foreground">
            Every component <code className="font-mono">renderSingleBlock</code> dispatches to,
            rendered from a literal <code className="font-mono">StreamBlock</code>. Specimens must
            render identically on every load — this page is in the layout-invariant sweep.
          </p>
        </div>
        {CHAT_BLOCK_SPECIMENS.map((specimen) => (
          <SpecimenFrame key={specimen.id} specimen={specimen} />
        ))}
      </div>
    </div>
  );
}

/**
 * Holds one specimen at the width the block gets in a real transcript column.
 * The width is load-bearing: the compact branch puts its chips and its field on
 * one row only if the column is wide enough to hold them, and that shared row is
 * what the geometry assertions measure.
 */
type SubmitAppComponent = NonNullable<RenderBlockOptions["onSubmitAppComponent"]>;
type DismissAppComponent = NonNullable<RenderBlockOptions["onDismissAppComponent"]>;

export interface ChatBlockPreviewProps {
  block: StreamBlock;
  result?: Record<string, unknown>;
  sessionId: string;
  onSubmitAppComponent: SubmitAppComponent;
  onDismissAppComponent: DismissAppComponent;
}

/** Renders a StreamBlock through the transcript's production dispatcher. */
export function ChatBlockPreview({
  block,
  result,
  sessionId,
  onSubmitAppComponent,
  onDismissAppComponent,
}: ChatBlockPreviewProps) {
  const results =
    result && block.toolUseId
      ? new Map([[interactionResultKey(sessionId, block.toolUseId), result]])
      : undefined;

  return renderSingleBlock(block, block.toolUseId ?? "chat-block-preview", {
    sessionId,
    interactionResults: results,
    onSubmitAppComponent,
    onDismissAppComponent,
  });
}

function SpecimenFrame({ specimen }: { specimen: Specimen }) {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-section text-foreground">{specimen.title}</h2>
        <p className="max-w-2xl text-body text-muted-foreground">{specimen.note}</p>
      </div>
      <div className="w-full max-w-2xl">
        <ChatBlockPreview
          block={specimen.block}
          result={specimen.result}
          sessionId={SESSION_ID}
          onSubmitAppComponent={noop}
          onDismissAppComponent={noop}
        />
      </div>
    </section>
  );
}

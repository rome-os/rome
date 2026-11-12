import { lazy, Suspense } from "react";
import { CardBoundary } from "./widget-ui/CardBoundary";
import { isDrawableCard } from "./widget-ui/drawable";

const WidgetUiCard = lazy(() =>
  import("./widget-ui/WidgetUiCard").then((m) => ({ default: m.WidgetUiCard })),
);

export interface QuestionCardProps {
  toolUseId: string;
  appId: string;
  /** The card core described from the questions (`render.ui`). */
  ui?: unknown;
  /** The questions as the agent asked them (`render.props`). */
  props?: Record<string, unknown>;
  /** Prior submitted output when this instance already resolved. */
  result?: Record<string, unknown>;
  onSubmit: (toolUseId: string, output: Record<string, unknown>, summary?: string) => void;
  onDismiss: (toolUseId: string) => void;
}

/**
 * The agent asked something: the card core described from its questions,
 * drawn as every reader draws it. A question stored before cards were
 * described, or one whose description cannot be drawn, shows its questions
 * as a line.
 */
export function QuestionCard({
  toolUseId,
  appId,
  ui,
  props,
  result,
  onSubmit,
  onDismiss,
}: QuestionCardProps) {
  const line = <QuestionLine props={props} />;
  if (!ui || !isDrawableCard(appId, ui, {}, true)) return line;
  return (
    <CardBoundary fallback={line}>
      <Suspense fallback={null}>
        <WidgetUiCard
          toolUseId={toolUseId}
          appId={appId}
          ui={ui as never}
          text=""
          waiting={{ result, onSubmit, onDismiss }}
        />
      </Suspense>
    </CardBoundary>
  );
}

function QuestionLine({ props }: { props?: Record<string, unknown> }) {
  const raw = props?.questions;
  const questions = Array.isArray(raw)
    ? raw.flatMap((q) =>
        q && typeof q === "object" && typeof (q as { question?: unknown }).question === "string"
          ? [(q as { question: string }).question]
          : [],
      )
    : [];
  return (
    <p className="whitespace-pre-line text-ui text-muted-foreground" data-question-line>
      {questions.join("\n")}
    </p>
  );
}

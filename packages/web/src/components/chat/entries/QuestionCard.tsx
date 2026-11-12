import { lazy, Suspense } from "react";
import { CardBoundary } from "./widget-ui/CardBoundary";
import { isDrawableCard } from "./widget-ui/drawable";

const WidgetUiCard = lazy(() =>
  import("./widget-ui/WidgetUiCard").then((m) => ({ default: m.WidgetUiCard })),
);

export interface QuestionCardProps {
  /** The widget's id: the id of the message that holds the card. */
  widgetId: string;
  toolUseId: string;
  appId: string;
  /** The card core described from the questions (`render.ui`). */
  ui?: unknown;
  /** The questions as the agent asked them (`render.props`). */
  props?: Record<string, unknown>;
  /** Prior submitted output when this instance already resolved. */
  result?: Record<string, unknown>;
  /** Sends Send or Dismiss, which core turns into the answer. */
  onAnswer: (
    widgetId: string,
    toolUseId: string,
    name: string,
    context: Record<string, unknown>,
  ) => void;
}

/**
 * The agent asked something: the card core described from its questions,
 * drawn as every reader draws it. A question stored before cards were
 * described, or one whose description cannot be drawn, shows its questions
 * as a line.
 */
export function QuestionCard({
  widgetId,
  toolUseId,
  appId,
  ui,
  props,
  result,
  onAnswer,
}: QuestionCardProps) {
  const line = <QuestionLine props={props} />;
  if (!ui || !isDrawableCard(appId, ui, {}, true)) return line;
  return (
    <CardBoundary fallback={line}>
      <Suspense fallback={null}>
        <WidgetUiCard
          widgetId={widgetId}
          toolUseId={toolUseId}
          appId={appId}
          ui={ui as never}
          text=""
          waiting={{ result, onAnswer }}
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

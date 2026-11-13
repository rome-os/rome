import { lazy, type ReactNode, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { answerOutcome, SettledCard } from "./SettledCard";
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
  /** Shown at the top inside the card, such as the task it is for. */
  header?: ReactNode;
  /**
   * How it shows once answered or dismissed: folded to what it asked and how
   * it ended, opening to the whole card read-only (the default), or whole.
   */
  settled?: "fold" | "full";
}

export function QuestionCard({ settled = "fold", ...card }: QuestionCardProps) {
  const { t } = useTranslation("chat");
  if (settled === "fold" && card.result !== undefined) {
    const title = questionsOf(card.props).join(" · ");
    return (
      <SettledCard
        title={title || null}
        outcome={answerOutcome(t, card.result)}
        full={<WholeQuestionCard {...card} />}
      />
    );
  }
  return <WholeQuestionCard {...card} />;
}

/**
 * The agent asked something: the card core described from its questions,
 * drawn as every reader draws it. A question stored before cards were
 * described, or one whose description cannot be drawn, shows its questions
 * as a line.
 */
function WholeQuestionCard({
  toolUseId,
  appId,
  ui,
  props,
  result,
  onSubmit,
  onDismiss,
  header,
}: Omit<QuestionCardProps, "settled">) {
  const line = <QuestionLine props={props} />;
  if (!ui || !isDrawableCard(appId, ui, {}, true)) return line;
  return (
    <CardBoundary fallback={line}>
      <Suspense fallback={null}>
        {header ? <div className="flex min-w-0 flex-col pb-2">{header}</div> : null}
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

function questionsOf(props?: Record<string, unknown>): string[] {
  const raw = props?.questions;
  return Array.isArray(raw)
    ? raw.flatMap((q) =>
        q && typeof q === "object" && typeof (q as { question?: unknown }).question === "string"
          ? [(q as { question: string }).question]
          : [],
      )
    : [];
}

function QuestionLine({ props }: { props?: Record<string, unknown> }) {
  const questions = questionsOf(props);
  return (
    <p className="whitespace-pre-line text-ui text-muted-foreground" data-question-line>
      {questions.join("\n")}
    </p>
  );
}

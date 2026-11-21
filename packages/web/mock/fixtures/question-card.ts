import { type Question, questionCardUi } from "@rome/api-types/question-card";

/** An `ask_question` card's render as core stores it: the questions, and the
 *  card described from them. */
export function questionCardRender(questions: Question[]) {
  return {
    kind: "inline" as const,
    componentId: "question-card",
    builtin: true,
    props: { questions },
    ui: questionCardUi(questions),
  };
}

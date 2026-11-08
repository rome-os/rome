// The shape an agent declares for its answer (its `outputSchema`), and the
// rule a turn's result must meet when it has one.

import type { TurnErrorEvent, TurnResultEvent } from "@rome-os/app-runtime";

/** Port. An agent's declared answer shape, ready to check an answer against. */
export interface AnswerShape {
  check(answer: unknown): { fits: true } | { fits: false; issues: string[] };
}

/** Port. Reads an agent's declared shape. Throws when Rome does not accept the schema. */
export type ReadAnswerShape = (schema: Record<string, unknown>) => AnswerShape;

/**
 * A result of an agent that declares an answer shape. It must carry a
 * structured answer that fits the shape, which then becomes its text. A turn
 * that suspended, such as on a card, cannot meet the shape, so it fails.
 */
export function shapedResult(
  result: TurnResultEvent,
  shape: AnswerShape,
  suspended: boolean,
): TurnResultEvent | TurnErrorEvent {
  const fail = (error: string): TurnErrorEvent => ({
    type: "error",
    error,
    accounting: result.accounting,
  });
  if (suspended) return fail("Agent cannot suspend a turn while outputSchema is configured");
  if (!Object.prototype.hasOwnProperty.call(result, "structuredOutput")) {
    return fail("Provider completed without structured output for the declared outputSchema");
  }
  const checked = shape.check(result.structuredOutput);
  if (!checked.fits) {
    return fail(
      `Provider returned structured output that failed Rome validation: ${checked.issues.join("; ")}`,
    );
  }
  try {
    return { ...result, content: JSON.stringify(result.structuredOutput) };
  } catch (err) {
    return fail(
      `Provider returned non-serializable structured output: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

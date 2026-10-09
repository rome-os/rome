/** What a scenario body uses to run itself. */
export interface ScenarioContext {
  /** Runs `run` as one labelled step and resolves with its result. A failing
   *  step fails the test with the step's label in the message. */
  step<T>(label: string, run: () => Promise<T> | T): Promise<T>;
}

/**
 * Runs a scenario as a sequence of labelled steps, so a failure names the
 * step it happened in, not only the assertion.
 */
export async function runScenario(
  body: (context: ScenarioContext) => Promise<void>,
): Promise<void> {
  await body({
    async step(label, run) {
      try {
        return await run();
      } catch (error) {
        if (error instanceof Error) error.message = `Step "${label}": ${error.message}`;
        throw error;
      }
    },
  });
}

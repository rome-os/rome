// One run of the patrol agent: a fresh agent session each time, recorded in
// the one "Concierge patrol" session as triage's runs are (../triage.ts).

import { textMessageContent, transcriptMessageId } from "../../core/agent-trace-recorder.js";
import type { AgentRunnerInterface } from "../../core/types.js";
import type { TriageRecordStore } from "../triage.js";

const PATROL_AGENT = "core:concierge-patrol";
/**
 * The one session every patrol run is recorded in, so Sessions shows
 * "Concierge patrol" with one run per patrol that passed its pre-check. It is
 * in no chat and in no task list.
 */
export const PATROL_SESSION_ID = "concierge-patrol";
const PATROL_TIMEOUT_MS = 180_000;

/** Runs the patrol agent once on `prompt`. Answers its structured answer, or throws. */
export async function runPatrolAgent(
  runner: AgentRunnerInterface,
  prompt: string,
  options: { record?: TriageRecordStore; timeoutMs?: number } = {},
): Promise<unknown> {
  const record = options.record;
  const collect = async () => {
    if (record) {
      await record.ensureRomeSession({
        id: PATROL_SESSION_ID,
        type: "action",
        name: "Concierge patrol",
        agentName: PATROL_AGENT,
      });
    }
    let content = "";
    let error = "";
    // No channel key: a fresh agent session per run, so no run carries
    // another's context. The named session only gathers the records.
    for await (const message of runner.run({
      agentName: PATROL_AGENT,
      prompt,
      initiatedBy: "system",
      ...(record ? { romeSessionId: PATROL_SESSION_ID } : { persistTrace: false }),
    })) {
      if (message.type === "turn_start" && record) {
        await record.addMessage(
          transcriptMessageId(PATROL_SESSION_ID, message.turnId, "user"),
          PATROL_SESSION_ID,
          "user",
          textMessageContent(prompt),
          message.turnId,
        );
      }
      if (message.type === "result") content = message.content;
      if (message.type === "error") error = message.error;
    }
    if (!content) throw new Error(error || "the patrol ended without a result");
    return JSON.parse(content) as unknown;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      collect(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("the patrol timed out")),
          options.timeoutMs ?? PATROL_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The patrol agent's file as written, for the checks and the eval that read
// its prompt and answer shape outside the agent catalog.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

/** The fields of `agents/concierge-patrol.yaml` as written, unchecked. */
export function readPatrolAgentFile(): Record<string, unknown> & {
  systemPromptPrefix: string;
  outputSchema: Record<string, unknown>;
  policy: Record<string, unknown>;
} {
  const here = dirname(fileURLToPath(import.meta.url));
  return parseYaml(readFileSync(resolve(here, "../../../agents/concierge-patrol.yaml"), "utf8"));
}

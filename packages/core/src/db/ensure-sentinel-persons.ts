import { STRANGER_PERSON_ID, STRANGER_PERSON_DISPLAY_NAME } from "../constants.js";
import type { PeopleRepository } from "./repositories/people.js";
import { createLogger } from "../logger.js";

const log = createLogger("ensure-sentinel-persons");

/**
 * Make sure the STRANGER sentinel person exists. Idempotent — safe to call on every startup.
 */
export async function ensureSentinelPersons(repo: PeopleRepository): Promise<void> {
  const existing = await repo.byId(STRANGER_PERSON_ID);
  if (existing) return;

  await repo.createWithId(STRANGER_PERSON_ID, {
    displayName: STRANGER_PERSON_DISPLAY_NAME,
    bondLevel: "other",
    approved: true,
  });
  log.info("Created STRANGER sentinel person", { id: STRANGER_PERSON_ID });
}

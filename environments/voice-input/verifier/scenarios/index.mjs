// Every rule the verifier checks, in run order. A later phase adds its rules here.
import r2 from "./r2-text-as-you-speak.mjs";
import r3 from "./r3-what-you-said.mjs";
import r5 from "./r5-only-you-send.mjs";
import r6 from "./r6-speaking-is-typing.mjs";
import r10 from "./r10-voice-goes-where-named.mjs";
import r11 from "./r11-rome-cloud-provides-it.mjs";

/** The rules version the scenarios encode. Change it with the rules doc. */
export const RULES_VERSION = "V5";

/** Rules and the phase each belongs to, including those with no scenario yet. */
export const RULE_PHASES = { 1: 3, 2: 1, 3: 1, 4: 2, 5: 1, 6: 1, 7: 2, 8: 2, 9: 2, 10: 1, 11: 1 };

/** Places voice input is scored in. Phase 1 has only the dashboard in Chrome. */
export const PLACES = ["chrome"];

// Rules 2, 3, 5 and 10 share the script runs; 10 reads the capture they leave.
export const SCENARIOS = [r2, r3, r5, r10, r6, r11];

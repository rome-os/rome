// Every rule the verifier checks, in run order. A later phase adds its rules here.
import r1 from "./r1-speak-wherever-you-type.mjs";
import r2 from "./r2-text-as-you-speak.mjs";
import r3 from "./r3-what-you-said.mjs";
import r5 from "./r5-only-you-send.mjs";
import r6 from "./r6-speaking-is-typing.mjs";
import r10 from "./r10-voice-goes-where-named.mjs";
import r11 from "./r11-rome-cloud-provides-it.mjs";
import r4 from "./r4-length-does-not-matter.mjs";
import r7 from "./r7-words-never-lost.mjs";
import r8 from "./r8-refusing-the-mic.mjs";
import r9 from "./r9-mic-open-only-while-listening.mjs";
import r12 from "./r12-the-microphone-you-chose.mjs";
import r13 from "./r13-enter-sends-what-you-said.mjs";
import r14 from "./r14-you-see-rome-hearing.mjs";

/** The rules version the scenarios encode. Change it with the rules doc. */
export const RULES_VERSION = "V6";

/** Rules and the phase each belongs to, including those with no scenario yet. */
export const RULE_PHASES = {
  1: 3,
  2: 1,
  3: 1,
  4: 2,
  5: 1,
  6: 1,
  7: 2,
  8: 2,
  9: 2,
  10: 1,
  11: 1,
  12: 4,
  13: 4,
  14: 4,
};

/**
 * Places the verifier scores: the dashboard in Chrome, the desktop app, and the iOS app's audio
 * path (leg A), which scores only the rules marked `legA`.
 */
export const PLACES = ["chrome", "desktop", "phone"];

// Rules 2, 3, 5 and 10 share the script runs; 10 reads the capture they leave. Rule 9 reads
// the microphone's closing from rule 7's stops, so it runs after them.
export const SCENARIOS = [r2, r3, r5, r10, r6, r11, r4, r7, r9, r8, r1, r12, r13, r14];

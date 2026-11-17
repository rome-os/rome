// Every rule the verifier checks, in run order. A later phase adds its rules here.
import a1 from "./a1-present.mjs";
import a2 from "./a2-hears.mjs";
import a3 from "./a3-silent.mjs";
import a5 from "./a5-right-place.mjs";
import a7 from "./a7-takes-a-hint.mjs";
import a8 from "./a8-catches-up.mjs";
import k1 from "./k1-team.mjs";
import k2 from "./k2-goals.mjs";
import k3 from "./k3-who-said-it.mjs";
import k4 from "./k4-stays-current.mjs";
import k5 from "./k5-no-invention.mjs";
import k6 from "./k6-survives-restart.mjs";
import k7 from "./k7-private.mjs";

/** The rules version the scenarios encode. Change it with the rules doc. */
export const RULES_VERSION = "R4";

// Fast rules first, so their results land early. A5 reads A1's replies, K5 reads K3's answers,
// and K6 reuses K1's and K2's. K5 and K6 run before K4 changes the goals they ask about. A2 and
// K4 share the move of the clock. A3's replay is the slowest, and A7 runs last, since it tells
// the agent to stay out of a topic.
export const SCENARIOS = [k1, k2, a1, a5, k7, k3, k5, k6, a8, a2, k4, a3, a7];

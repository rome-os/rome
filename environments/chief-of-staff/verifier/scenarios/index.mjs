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

// K6 restarts Rome, so it runs after the rules whose answers it reuses, and before K4 changes
// the goals it compares. A3 runs before the clock moves a day for A2 and K4, so its cost reads
// in real time. A8 stops Rome for an hour. A7 runs last, since it tells the agent to stay
// out of a topic.
export const SCENARIOS = [k1, k2, k3, k5, k7, a1, a5, k6, a3, a2, k4, a8, a7];

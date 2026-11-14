// Every rule the verifier checks, in run order. A later phase adds its rules here.
import a1 from "./a1-present.mjs";
import a5 from "./a5-right-place.mjs";
import k1 from "./k1-team.mjs";
import k2 from "./k2-goals.mjs";
import k3 from "./k3-who-said-it.mjs";
import k5 from "./k5-no-invention.mjs";
import k6 from "./k6-survives-restart.mjs";
import k7 from "./k7-private.mjs";

/** The rules version the scenarios encode. Change it with the rules doc. */
export const RULES_VERSION = "R4";

// K6 restarts Rome, so it runs after the rules whose answers it reuses.
export const SCENARIOS = [k1, k2, k3, k5, k7, a1, a5, k6];

// What the connection's port answered. A refusal is `{refused: why}`, or, as
// the environment's port returns one verbatim, an error with `at` ("rome" or
// "connector") naming where it was refused.

/** Whether answer `a` is a refusal. */
export const refused = (a) =>
  Boolean(a && typeof a === "object" && (a.refused || (a.at && (a.error || a.reason || a.message))));

/** Why answer `a` was refused, in the port's words. */
export const why = (a) => {
  const w = a?.refused ?? a?.error ?? a?.reason ?? a?.message;
  return `${typeof w === "string" ? w : JSON.stringify(w)}${a?.at ? ` (at ${a.at})` : ""}`;
};

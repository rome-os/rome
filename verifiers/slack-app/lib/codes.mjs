// Seeded messages ask the Concierge something harmless. A reply is matched to
// its message by where and when the fake Slack records it, never by what it
// says: Slack links a direct message reply to nothing, and the Concierge may
// answer in any words. Each message carries a tag unique to it and the run,
// so Rome's records and Slack calls about it can be found. No reply needs to
// repeat the tag.

import { randomBytes } from "node:crypto";

const run = randomBytes(2).toString("hex");

/** A tag unique to this run, such as `R4-07-3fa2`. */
export const code = (rule, i) => `${rule}-${String(i).padStart(2, "0")}-${run}`;

const QUESTIONS = [
  "What day comes after Monday?",
  "How many legs does a cat have?",
  "What colour is a clear sky at noon?",
  "Which is bigger, ten or three?",
  "What do bees make?",
];

/** The text of a seeded message tagged `tag`: a harmless question. */
export const ask = (tag) => {
  const n = Number(tag.split("-")[1] ?? 0);
  return `${QUESTIONS[n % QUESTIONS.length]} (message ${tag})`;
};

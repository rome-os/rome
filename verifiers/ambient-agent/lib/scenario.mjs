// What the members say: facts with values made fresh each run, questions
// about them, filler talk that holds no value, and the unmentioned messages
// of the silence rule. Lives only in this folder, so the product builder
// never sees it.

import { randomInt } from "node:crypto";

// Each value is one of these words and a number drawn per run, so no model
// can know or guess it, and none names a common thing a reply could hold by
// chance.
const WORDS = [
  "QUILLON",
  "MARZIPAN",
  "BASALT",
  "TAMARIND",
  "OSPREY",
  "VERDIGRIS",
  "LODESTAR",
  "PERIWINKLE",
  "SPINDRIFT",
  "FENNEL",
  "CORMORANT",
  "ZEPHYR",
  "GALLIARD",
  "HALYARD",
  "JUNIPER",
  "KESTREL",
  "MANDOLIN",
  "NIGHTJAR",
  "OBSIDIAN",
  "PAPRIKA",
  "QUARTZITE",
  "RUDDOCK",
  "SAFFRON",
  "TOURMALINE",
  "UMBRA",
  "VELLUM",
  "WAXWING",
  "YARROW",
  "ARGOSY",
  "BRAMBLING",
  "CINNABAR",
  "DUNLIN",
];

const TOPICS = [
  "door code for the storage room",
  "wifi password for the guest network",
  "booking reference for the offsite hotel",
  "name of the new staging database",
  "tracking number for the monitor shipment",
  "codename for the spring release",
  "PIN for the third floor printer",
  "combination for the bike locker",
  "badge number for the visiting contractor",
  "budget code for the team lunch",
  "label on the backup drive",
  "reference for the vendor invoice",
  "password for the shared demo account",
  "ticket for the flaky login bug",
  "voucher code for the training course",
  "serial number of the loaner laptop",
  "gate code at the warehouse",
  "account number for the courier",
  "license key for the diagram tool",
  "confirmation code for the team dinner",
  "room code for the video call",
  "plate number of the rental van",
  "batch number of the returned headsets",
  "pager code for this week's on-call",
];

const FACTS = [
  (t, v) => `Heads up: the ${t} is ${v}.`,
  (t, v) => `FYI the ${t} changed, it's ${v} now`,
  (t, v) => `Writing this down so nobody has to ask again. ${cap(t)}: ${v}`,
  (t, v) => `just got it from facilities, ${t} = ${v}`,
  (t, v) => `For whoever needs it later, the ${t} is ${v}. Don't lose it!`,
  (t, v) => `${cap(t)} is ${v} (it was something else last month)`,
];

const QUESTIONS = [
  (t) => `what's the ${t}?`,
  (t) => `someone posted the ${t} a bit earlier, can you tell me what it was?`,
  (t) => `do you remember the ${t} from above?`,
  (t) => `quick one: ${t}? I missed it`,
  (t) => `could you look back and give me the ${t}`,
  (t) => `I need the ${t}, what did they say it was?`,
];

const FILLER = [
  "Morning all, coffee machine on two is fixed.",
  "Did anyone see the design review notes?",
  "I'll be late to standup, dentist.",
  "The deploy went out fine as far as I can tell.",
  "lol that meeting could have been an email",
  "Can someone take a look at my pull request when you get a sec?",
  "Lunch is pizza again, apparently.",
  "Reminder that the quarterly survey closes Friday.",
  "Heading out early today, ping me on my phone if it's urgent.",
  "Has anyone tried the new standing desks?",
  "The client call moved to after lunch.",
  "nice work on the demo yesterday",
  "Is the staging site slow for anyone else?",
  "I'm out next week, Bob is covering for me.",
  "We should clean up the shared drive at some point.",
  "Thanks for the help earlier!",
  "Who's ordering the cake for the farewell?",
  "Fire drill at eleven, don't panic.",
  "The roadmap doc has comments open now.",
  "Anybody else's calendar acting weird?",
  "Plants on the window sill need water.",
  "Spreadsheet updated with the latest numbers.",
  "Please don't park in the loading bay.",
  "Good point, let's talk after the sync.",
  "Back from holiday, catching up on everything.",
  "Interview panel needs one more person on Thursday.",
  "sounds good to me",
  "The heater in the small room is broken again.",
  "Can we push the retro to next week?",
  "Great article on onboarding, worth a read.",
];

// The silence rule's 50 messages, by kind. The agent's name appears only as
// plain text, never as a mention.
const SILENCE = {
  plain: [
    "Standup notes are in the doc.",
    "Build is green again.",
    "I moved the planning meeting to Wednesday.",
    "The printer is out of toner.",
    "Welcome to the team, Dana!",
    "Office closes early on Friday.",
    "Pushed the fix for the header layout.",
    "New laptops arrive next month.",
    "Lunch and learn is on security this week.",
    "Updated the onboarding checklist.",
    "Coffee beans are in the cupboard.",
    "The release notes are drafted.",
    "Cleaned up the old branches.",
    "I'll be offline for an hour.",
    "Expense reports are due Monday.",
    "The wiki migration is finished.",
    "Snacks restocked in the kitchen.",
    "Calendar invites for the offsite went out.",
    "Fixed the typo on the landing page.",
    "Retro board is up for this sprint.",
  ],
  question: [
    "Does anyone know where the spare chargers went?",
    "Who has the key to the supply cabinet?",
    "Is the all-hands still at three?",
    "Can anyone review my doc today?",
    "What time does the cafe close?",
    "Anyone up for a walk at lunch?",
    "Is there a template for the incident report?",
    "Where do we keep the conference phone?",
    "Did the vendor ever reply?",
    "Should we move the sync to the afternoon?",
  ],
  thread: [
    "Agreed.",
    "I can take that one.",
    "Same here, it's been flaky all week.",
    "Let's sort it out tomorrow.",
    "Thanks, that worked.",
    "Not sure, maybe ask facilities?",
    "Same, thanks.",
    "I'll check after lunch.",
    "Done.",
    "Good catch.",
  ],
  name: [
    "rome would probably know this",
    "Rome, never mind, found it",
    "I asked Rome yesterday about something similar",
    "@rome is not here right now",
    "maybe the Concierge can sort this out later",
    "Rome?",
    "talking about rome: the bot has been useful",
    "I'll ask rome tomorrow",
    "ROME bot docs are in the wiki",
    "the rome concierge setup is done",
  ],
};

// Rules 5 to 8. Each mention carries or asks for a value found nowhere else,
// so where its answer landed is read off the posts mechanically.
const ECHO = [
  (v) => `can you post the code ${v} back here so I know you saw this?`,
  (v) => `please reply with ${v} in this conversation`,
  (v) => `just checking you're listening: answer with ${v}`,
  (v) => `repeat this code back to me here: ${v}`,
  (v) => `for the log, say ${v} back to me`,
];

const PRIVATE = [
  (v) =>
    `just between us: my locker code is ${v}. Repeat it back to me here so I know you have it.`,
  (v) => `keep this private please. My badge PIN is ${v}, can you confirm it back to me?`,
  (v) => `only for you: the code for my desk drawer is ${v}. Say it back so I know it reached you.`,
];

const WORK = (word, a, b) =>
  `Start a task for this, please, rather than doing it yourself: multiply ${a} by ${b}, and when the task is done post the answer here as ${word}-<the product>.`;

// Rule 6 asks about many facts per run, so a topic is qualified by a place
// that names no value word and holds no digit.
const QUALIFIERS = [
  "at the north office",
  "for the design team",
  "for the night shift",
  "at the harbour site",
  "for the visitors",
  "for the finance team",
];

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const pick = (list) => list[randomInt(list.length)];

// Numbers drawn in this process, so no two values of a run share one.
const usedNumbers = new Set();
function freshNumber(digits) {
  for (;;) {
    const n = String(randomInt(10 ** (digits - 1), 10 ** digits));
    if (!usedNumbers.has(n)) {
      usedNumbers.add(n);
      return n;
    }
  }
}

/** `n` values made this run, each a word and a number no other value of the run holds: {word, number, value}. */
export function drawValues(n) {
  return Array.from({ length: n }, () => {
    const word = pick(WORDS);
    const number = freshNumber(5);
    return { word, number, value: `${word}-${number}` };
  });
}

/** Draws `n` facts, each with its own topic and a value made this run: {topic, value, word, number}. */
export function drawFacts(n, { exclude = [], qualified = false } = {}) {
  const topics = qualified
    ? TOPICS.flatMap((t) => QUALIFIERS.map((q) => `${t} ${q}`)).filter((t) => !exclude.includes(t))
    : TOPICS.filter((t) => !exclude.includes(t));
  if (n > topics.length) throw new Error(`only ${topics.length} topics left for ${n} facts`);
  const chosen = [];
  const words = new Set();
  while (chosen.length < n) {
    const topic = topics.splice(randomInt(topics.length), 1)[0];
    let word;
    do word = pick(WORDS);
    while (!qualified && words.has(word));
    words.add(word);
    const number = freshNumber(4);
    chosen.push({ topic, word, number, value: `${word}-${number}` });
  }
  return chosen;
}

/** One fact's sentence, round `i` picking the phrasing. */
export const factText = (fact, i) => FACTS[i % FACTS.length](fact.topic, fact.value);

/** The question about one fact, round `i` picking the phrasing. */
export const questionText = (fact, i) => QUESTIONS[(i * 5 + 1) % QUESTIONS.length](fact.topic);

/** A mention asking the agent to say value `v` back, `i` picking the phrasing. */
export const echoText = (v, i) => ECHO[i % ECHO.length](v.value);

/** A direct message asking the agent to say a private value back. */
export const privateText = (v, i) => PRIVATE[i % PRIVATE.length](v.value);

/**
 * A mention asking for work another agent does: a product the agent must
 * post as `<word>-<product>`. Returns {text, word, number, value}; the value
 * is not in the text, so only the work's result can hold it.
 */
export function workRequest() {
  const a = randomInt(101, 1000);
  const b = randomInt(101, 1000);
  const word = pick(WORDS);
  const number = String(a * b);
  usedNumbers.add(number);
  return { text: WORK(word, a, b), word, number, value: `${word}-${number}` };
}

/** `n` filler messages, none holding a digit or a value word. */
export function fillers(n) {
  const pool = [...FILLER];
  return Array.from({ length: n }, () => pool.splice(randomInt(pool.length), 1)[0]);
}

/** The silence rule's 50 messages: 20 plain, 10 questions nobody is named in, 10 thread replies, 10 with the agent's name as plain text. */
export function silenceMessages() {
  return { ...SILENCE };
}

/**
 * Whether `text` holds the value: its word, then its number, as a person
 * would write them (any case, up to four separators between, such as "-",
 * " " or "**-"). The number must stand on its own, not inside a longer one.
 */
export function holdsValue(text, value) {
  // Thousands separators may sit between the digits: "544,617".
  const number = [...value.number].join(",?");
  return new RegExp(`${value.word}[^A-Za-z0-9]{0,4}${number}(?![\\d,]*\\d)`, "i").test(
    String(text ?? ""),
  );
}

export const _forTests = { WORDS, FILLER, SILENCE, TOPICS, QUALIFIERS };

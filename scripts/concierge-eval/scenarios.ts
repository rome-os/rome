// The fixed owner script each round plays: one fresh Concierge topic chat per
// scenario, the owner's messages in order, and how the owner answers cards.
// Change a scenario and earlier labels stop being comparable: bump
// SCENARIOS_VERSION so a comparison says so. docs/concierge-eval.md

export const SCENARIOS_VERSION = 1;

export interface Step {
  text: string;
  /** Send it as a Reply to the Concierge's latest text message in a task's thread. */
  replyToResult?: boolean;
}

export interface Scenario {
  id: string;
  /** What the scenario checks, for the report. */
  about: string;
  steps: Step[];
  /** How the owner answers each question card: its first option, or never. */
  cards: "first" | "never";
  /** How the owner decides each approval. */
  approvals: "approve" | "reject" | "never";
  expect: {
    /** The Concierge must show a card for the owner to decide. */
    decision?: boolean;
    /** Each must match some text the Concierge sent: the real result. */
    results?: RegExp[];
    /** How the scenario's tasks must end. */
    endReason: "done" | "no_response";
    /** Needs the wait expiry shortened (CONCIERGE_TASK_WAIT_EXPIRY_MINUTES). */
    waitsForExpiry?: boolean;
    /** A file under the default project that must exist, or must not, when the round ends. */
    file?: { name: string; exists: boolean };
  };
}

export const SCENARIOS: Scenario[] = [
  {
    id: "ask-one",
    about: "A small task whose only job is one question",
    steps: [
      {
        text: "Make it a task: ask me with a question card whether I prefer tea or coffee in the afternoon, and note my pick in your memory.",
      },
    ],
    cards: "first",
    approvals: "never",
    expect: { decision: true, endReason: "done" },
  },
  {
    id: "approve",
    about: "A task that needs an approval, approved",
    steps: [
      {
        text: "Make it a task: write the line 'eval approved' to a file named eval-approve.txt in the default project. Ask for my approval with system:request_approval_demo before writing it.",
      },
    ],
    cards: "first",
    approvals: "approve",
    expect: {
      decision: true,
      endReason: "done",
      file: { name: "eval-approve.txt", exists: true },
    },
  },
  {
    id: "reject",
    about: "A task that needs an approval, rejected",
    steps: [
      {
        text: "Make it a task: write the line 'eval rejected' to a file named eval-reject.txt in the default project. Ask for my approval with system:request_approval_demo before writing it.",
      },
    ],
    cards: "first",
    approvals: "reject",
    expect: {
      decision: true,
      endReason: "done",
      file: { name: "eval-reject.txt", exists: false },
    },
  },
  {
    id: "quick",
    about: "A quick question answered directly",
    steps: [{ text: "What's the weather in Tokyo right now?" }],
    cards: "never",
    approvals: "never",
    expect: { results: [/°|℃|degrees|rain|cloud|sun|clear|wind|snow|humid/i], endReason: "done" },
  },
  {
    id: "research",
    about: "A longer task with a real result to report",
    steps: [
      {
        text: "Compare the three most popular open-source vector databases: license, main implementation language, and one standout feature each.",
      },
    ],
    cards: "first",
    approvals: "approve",
    expect: {
      results: [/milvus|qdrant|weaviate|chroma|pgvector|lancedb|faiss/i],
      endReason: "done",
    },
  },
  {
    id: "no-response",
    about: "A task the owner never answers, ending for no response",
    steps: [
      {
        text: "Make it a task: ask me with a question card which city I'd like for a weekend trip, Lisbon, Porto or Madrid, then plan two days there.",
      },
    ],
    cards: "never",
    approvals: "never",
    expect: { decision: true, endReason: "no_response", waitsForExpiry: true },
  },
  {
    id: "several",
    about: "Several tasks at once",
    steps: [
      {
        text: "Three separate things, please: write a four-line poem about rain and save it as eval-rain.txt in the default project; write a haiku about snow and save it as eval-snow.txt there; and tell me how many files the default project folder holds.",
      },
    ],
    cards: "first",
    approvals: "approve",
    expect: { results: [/rain/i, /snow/i, /\d/], endReason: "done" },
  },
  {
    id: "follow-ups",
    about: "One follow-up via Reply and one plain",
    steps: [
      { text: "Make it a task: draft a short packing list for a three-day beach trip." },
      { text: "Add sunscreen and make it for two people.", replyToResult: true },
      { text: "Also give me the list in French." },
    ],
    cards: "first",
    approvals: "approve",
    expect: {
      results: [
        /towel|swim|sandal|sunscreen/i,
        /two|2 people|both/i,
        /serviette|maillot|crème|lunettes|chapeau/i,
      ],
      endReason: "done",
    },
  },
];

// The long baseline scenarios: two conversations of a dozen turns, which
// check that answers stay short and early facts stay known, and a chat
// preloaded to a long context, which times simple turns at the tail of the
// latency spread. docs/concierge-eval.md#baseline

import {
  type BaselineScenario,
  type CheckInput,
  answeredInline,
  matches,
  noFiller,
  saidLength,
} from "./baseline-checks.js";
import { thanksWithoutEyes } from "./baseline-rules.js";

/**
 * A late probe may run longer than its early twin by this much before the
 * answers count as drifting: twice as long, or 150 characters more.
 */
function noLengthDrift(input: CheckInput, early: number, late: number): string[] {
  const a = saidLength(input, early);
  const b = saidLength(input, late);
  if (a === 0 || b === 0) return [];
  return b > Math.max(2 * a, a + 150)
    ? [`drift: step ${late + 1} answer is ${b} chars, its twin at step ${early + 1} ${a}`]
    : [];
}

/** Mean answer length of the steps from `from` up to `to`, the thanks left out. */
function meanLength(input: CheckInput, from: number, to: number): number | null {
  const lengths: number[] = [];
  for (let s = from; s < to; s++) {
    const n = saidLength(input, s);
    if (n > 0) lengths.push(n);
  }
  return lengths.length ? Math.round(lengths.reduce((x, y) => x + y, 0) / lengths.length) : null;
}

function conversationMeasures(input: CheckInput, probes: number[], last: number) {
  const [early, mid, late] = probes as [number, number, number];
  const half = Math.floor(last / 2);
  return {
    probeEarlyChars: saidLength(input, early),
    probeMidChars: saidLength(input, mid),
    probeLateChars: saidLength(input, late),
    firstHalfMeanChars: meanLength(input, 0, half),
    secondHalfMeanChars: meanLength(input, half, last),
  };
}

const VOICE_EN =
  "Voice: short and direct, like a capable assistant texting its owner; no preamble, no filler such as 'Got it' or 'Let me check', no closing offers.";

const VOICE_ZH =
  "语气：简短直接，像能干的助理给主人发消息；不要开场白和填充，结尾不要主动提出帮忙或反问。用中文回答，用全角标点。";

const WARM = 5;

// The steps at index 2, 6 and 9 are the same kind of quick sum, so their
// answers should stay the same length however long the chat grew.
const EN_CONVERSATION = [
  "Planning a weekend in Lisbon with my partner Sam, Friday to Sunday. Heads up: Sam is vegetarian and I'm allergic to shellfish.",
  "Budget is about 600 € for the two of us, flights not included.",
  "quick one: what's 18% of 250?",
  "Is late October a good time weather-wise?",
  "What's the local name for the custard tarts?",
  "Roughly how long is the tram 28 ride end to end?",
  "quick one: what's 15% of 340?",
  "Is the Lisboa Card worth it for two days?",
  "Which neighbourhood would you stay in on a first visit?",
  "quick one: what's 12% of 475?",
  "Remind me: what's our budget, and what can't each of us eat?",
  "thanks!",
];

const ZH_CONVERSATION = [
  "我和小林打算周五到周日去杭州玩一个周末。先说一下：小林吃素，我对花生过敏。",
  "预算两个人大概 2000 元，不算车票。",
  "顺便算一下：250 的 18% 是多少？",
  "十月底去杭州天气合适吗？",
  "西湖边有什么值得吃的本地小吃？",
  "从杭州东站到西湖大概要多久？",
  "顺便算一下：340 的 15% 是多少？",
  "灵隐寺需要提前预约吗？",
  "第一次去的话住哪个区域比较方便？",
  "顺便算一下：475 的 12% 是多少？",
  "提醒我一下：我们预算多少，谁不能吃什么？",
  "谢谢！",
];

const PROBES = [2, 6, 9];

/** A deterministic pseudo-random sequence, so every run preloads the same text. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const ROOMS = ["kitchen", "bathroom", "hallway", "living room", "bedroom", "attic", "cellar"];
const TRADES = [
  ["tiler", "Marco"],
  ["plumber", "Ines"],
  ["carpenter", "Tobias"],
  ["painter", "Aylin"],
  ["plasterer", "Piotr"],
];
const JOBS = [
  "stripped the old tiles and levelled the floor",
  "replaced two sections of corroded pipe under the sink",
  "fitted the new skirting boards and filled the gaps",
  "primed the walls and did the first coat",
  "patched the cracks around the window frame",
  "moved the radiator and capped the old feed",
  "laid the underlay and the first rows of oak boards",
  "sealed the shower tray and tested it for leaks",
];

/** The fact the long chat asks for at the end, buried in the first part of its log. */
const NEEDLE =
  "Note: the electrician for the rewiring is Jonas Brandt, booked for 3 December from 8:00; he needs the fuse box cleared.";

/**
 * Part `part` of a renovation diary, about `chars` long, which fills the
 * chat's context the way pasted notes do.
 */
export function renovationLog(part: number, chars: number): string {
  const random = seeded(1000 + part);
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)] as T;
  const lines: string[] = [];
  let day = part * 40 + 1;
  let length = 0;
  while (length < chars) {
    const [trade, name] = pick(TRADES) as [string, string];
    const hours = 2 + Math.floor(random() * 7);
    const cost = 80 + Math.floor(random() * 900);
    const line = `Day ${day}: ${name} the ${trade} ${pick(JOBS)} in the ${pick(ROOMS)}, ${hours} hours, ${cost} € for materials. ${random() < 0.3 ? "Waiting on a delivery for the next step." : "Next step agreed for the following week."}`;
    lines.push(line);
    length += line.length + 1;
    day++;
    if (part === 0 && lines.length === 12) lines.push(NEEDLE);
  }
  return lines.join("\n");
}

const PRELOAD_PARTS = 4;
const PRELOAD_CHARS = 45_000;

/** The context a long-context turn should run with, so its preload counts as done. */
const LONG_CONTEXT_TOKENS = 55_000;

export const LONG_SCENARIOS: BaselineScenario[] = [
  {
    id: "multi-turn",
    lang: "en",
    row: "multi-turn",
    about: "A dozen-turn trip-planning chat: answers stay short, early facts stay known",
    steps: EN_CONVERSATION.map((text) => ({ text, settleS: WARM })),
    check: (i) => [
      ...EN_CONVERSATION.slice(0, -1).flatMap((_, s) => answeredInline(i, s, 3)),
      ...noLengthDrift(i, PROBES[0] as number, PROBES[2] as number),
      ...matches(i.saidAfter[10] ?? [], /600/, "the 600 € budget"),
      ...matches(i.saidAfter[10] ?? [], /vegetarian|meat/i, "Sam being vegetarian"),
      ...matches(i.saidAfter[10] ?? [], /shellfish/i, "the shellfish allergy"),
      ...thanksWithoutEyes(i.steps[11] ?? null, i.reactions[11], 11),
      ...noFiller(i.said),
    ],
    measure: (i) => conversationMeasures(i, PROBES, 11),
    rubric: `A twelve-message chat planning a Lisbon weekend. Facts from the start: partner Sam is vegetarian, the owner is allergic to shellfish, the budget is about 600 € for two without flights. Expected answers: 18% of 250 = 45; 15% of 340 = 51; 12% of 475 = 57; late October is mild (around 18-22 °C, some rain); the tarts are pastéis de nata; tram 28 takes roughly 40-60 minutes end to end; the Lisboa Card pays off only with many museum visits and transport; a central area such as Baixa, Chiado or Alfama for a first visit. The second-to-last answer must give the 600 € budget, Sam's vegetarian diet and the shellfish allergy. Answers late in the chat should be as short as early ones: score down if they grow, if the assistant repeats earlier context unasked, or if a tip ignores the diet or the allergy. ${VOICE_EN}`,
  },
  {
    id: "zh-multi-turn",
    lang: "zh",
    row: "multi-turn",
    about: "十几轮的出行规划聊天：回答保持简短，早先的事实记得住",
    steps: ZH_CONVERSATION.map((text) => ({ text, settleS: WARM })),
    check: (i) => [
      ...ZH_CONVERSATION.slice(0, -1).flatMap((_, s) => answeredInline(i, s, 3)),
      ...noLengthDrift(i, PROBES[0] as number, PROBES[2] as number),
      ...matches(i.saidAfter[10] ?? [], /2000|两千|2,000/, "the 2000 yuan budget"),
      ...matches(i.saidAfter[10] ?? [], /素/, "Xiaolin being vegetarian"),
      ...matches(i.saidAfter[10] ?? [], /花生/, "the peanut allergy"),
      ...thanksWithoutEyes(i.steps[11] ?? null, i.reactions[11], 11),
      ...noFiller(i.said),
    ],
    measure: (i) => conversationMeasures(i, PROBES, 11),
    rubric: `十二条消息的杭州周末规划聊天。开头给出的事实：小林吃素，主人对花生过敏，两人预算约 2000 元，不含车票。预期答案：250 的 18% = 45；340 的 15% = 51；475 的 12% = 57；十月底杭州气温舒适（约 15-23 °C）；西湖边的小吃如定胜糕、葱包桧、片儿川等（推荐需顾及吃素和花生过敏）；杭州东站到西湖地铁或打车约 30-40 分钟；灵隐寺一般无需预约，节假日可能需要；第一次去住西湖附近（如湖滨）方便。倒数第二个回答必须给出 2000 元预算、小林吃素和花生过敏。聊天后段的回答应和前段一样简短：变长、无故重复前文、推荐忽略饮食限制，都要扣分。${VOICE_ZH}`,
  },
  {
    id: "long-context",
    lang: "en",
    row: "long-context",
    about: `Simple turns in a chat preloaded to about ${Math.round(LONG_CONTEXT_TOKENS / 1000)}K+ tokens of context`,
    steps: [
      ...Array.from({ length: PRELOAD_PARTS }, (_, part) => ({
        text: `Part ${part + 1} of ${PRELOAD_PARTS} of my renovation log, so you have it in this chat. No need to reply, summarise or save it anywhere:\n\n${renovationLog(part, PRELOAD_CHARS)}`,
        settleS: WARM,
        setup: true,
      })),
      { text: "quick one: what's 15% of 240?", settleS: WARM },
      { text: "What's the difference between a flat white and a latte?", settleS: WARM },
      { text: "From the log: who's the electrician, and when is he booked?", settleS: WARM },
      { text: "thanks!", settleS: WARM },
    ],
    check: (i) => {
      const first = PRELOAD_PARTS;
      const notes = [
        ...answeredInline(i, first),
        ...answeredInline(i, first + 1),
        ...answeredInline(i, first + 2),
        ...matches(i.saidAfter[first] ?? [], /\b36\b/, "36"),
        ...matches(i.saidAfter[first + 1] ?? [], /milk|foam/i, "the milk"),
        ...matches(i.saidAfter[first + 2] ?? [], /jonas|brandt/i, "Jonas Brandt"),
        ...matches(i.saidAfter[first + 2] ?? [], /3 dec|dec(ember)? 3|3\.12|12\/3/i, "3 December"),
        ...thanksWithoutEyes(i.steps[first + 3] ?? null, i.reactions[first + 3], first + 3),
        ...noFiller(i.saidAfter.slice(first).flat()),
      ];
      const context = i.steps[first]?.contextTokens ?? null;
      if (context !== null && context < LONG_CONTEXT_TOKENS) {
        notes.push(`preload: context only ${Math.round(context / 1000)}k tokens`);
      }
      return notes;
    },
    measure: (i) => ({ contextTokens: i.steps[PRELOAD_PARTS]?.contextTokens ?? null }),
    rubric: `The owner pasted four long parts of a renovation log, asking for no reply; judge only from the line "quick one" on, plus whether the replies to the pasted parts were at most a short acknowledgement or a reaction. Expected: 15% of 240 = 36; a flat white has less milk and thin microfoam, a latte more steamed milk and thicker foam; the log names Jonas Brandt as the electrician, booked for 3 December from 8:00, and it says he needs the fuse box cleared, so mentioning that is fine. Score 1 if the electrician or date is wrong. A long context is no excuse for long answers. ${VOICE_EN}`,
  },
];

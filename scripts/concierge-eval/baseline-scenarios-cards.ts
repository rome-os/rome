// The card scenarios: content with a real structure, which the Concierge
// should show as one card it composes (docs/domains/chats.md#agent-card),
// in English and in Chinese. The chat and simple-question scenarios are the
// other half: `cardRules` in baseline-checks.ts refuses a card there.
// docs/concierge-eval.md#baseline

import { type BaselineScenario, matches, noFiller, shownCard } from "./baseline-checks.js";

const VOICE =
  "Voice: short and direct; the card holds the content, and any line around it neither repeats the card nor ends with an offer.";

const VOICE_ZH =
  "语气：简短直接；内容放在卡片里，卡片外的话不重复卡片内容，结尾不主动提出帮忙。用中文，用全角标点。";

/** What was shown after the step: its messages and its cards' plain text. */
const shown = (i: Parameters<BaselineScenario["check"]>[0], step: number) => [
  ...(i.saidAfter[step] ?? []),
  ...(i.cardsAfter[step] ?? []),
];

const ITINERARY =
  "I land in Lisbon at 9:00 on Saturday and fly out Sunday evening. I want Belém, a proper local lunch, the Alfama, and a sunset at a miradouro. Lay out the two days for me.";

const COMPARE =
  "Kindle Paperwhite, Kobo Clara or iPad mini, just for reading novels in bed and on the train: compare them for me.";

const NUMBERS =
  "I take home $6,200 a month. Rent is $2,100, groceries $650, transport $180, subscriptions $90, and I put $800 into savings. How much is left, and what share of my pay goes to rent?";

export const CARD_SCENARIOS: BaselineScenario[] = [
  {
    id: "card-itinerary",
    lang: "en",
    row: "cards",
    about: "A two-day itinerary, laid out in steps",
    steps: [{ text: ITINERARY, settleS: 8 }],
    check: (i) => [
      ...shownCard(i, 0),
      ...matches(shown(i, 0), /bel[ée]m/i, "Belém"),
      ...matches(shown(i, 0), /alfama/i, "the Alfama"),
      ...noFiller(i.said),
    ],
    rubric: `The owner asks for a two-day Lisbon plan. A good answer is a clear day-by-day plan with times or parts of the day, covering Belém, a local lunch, the Alfama and a sunset viewpoint, in a sensible geographic order (Belém on one side of the city, the Alfama on the other). Score the plan's quality and clarity. ${VOICE}`,
  },
  {
    id: "card-compare",
    lang: "en",
    row: "cards",
    about: "Three options compared side by side",
    steps: [{ text: COMPARE, settleS: 8 }],
    check: (i) => [
      ...shownCard(i, 0),
      ...matches(shown(i, 0), /kindle|paperwhite/i, "the Kindle"),
      ...matches(shown(i, 0), /kobo/i, "the Kobo"),
      ...matches(shown(i, 0), /ipad/i, "the iPad mini"),
      ...noFiller(i.said),
    ],
    rubric: `A good answer compares the three on what matters for reading novels: screen (e-ink vs LCD/OLED glare and eye strain), battery (weeks vs hours), weight, price, and store or library lending (Kobo's OverDrive/Libby), and ends with a clear pick for this use, most likely an e-reader. Score accuracy and how easy the comparison is to scan. ${VOICE}`,
  },
  {
    id: "card-numbers",
    lang: "en",
    row: "cards",
    about: "A few key numbers from a quick calculation",
    steps: [{ text: NUMBERS, settleS: 8 }],
    check: (i) => [
      ...shownCard(i, 0),
      ...matches(shown(i, 0), /2,?380/, "the $2,380 left"),
      ...matches(shown(i, 0), /33[.,]9|34\s?%/, "rent at about 34%"),
      ...noFiller(i.said),
    ],
    rubric: `Correct numbers: spending is 2,100 + 650 + 180 + 90 + 800 = $3,820, so $2,380 is left; rent is 2,100 / 6,200 ≈ 33.9% of take-home pay. Score 1 for a wrong figure. A good answer shows these key numbers plainly, with at most a short note. ${VOICE}`,
  },
  {
    id: "zh-card-itinerary",
    lang: "zh",
    row: "cards",
    about: "两天行程，按步骤排开",
    steps: [
      {
        text: "我周六早上 9 点到里斯本，周日晚上走。想去贝伦区、吃一顿地道的午饭、逛阿尔法玛，再找个观景台看日落。帮我把这两天排一下。",
        settleS: 8,
      },
    ],
    check: (i) => [
      ...shownCard(i, 0),
      ...matches(shown(i, 0), /贝伦|bel[ée]m/i, "贝伦区"),
      ...matches(shown(i, 0), /阿尔法玛|alfama/i, "阿尔法玛"),
      ...noFiller(i.said),
    ],
    rubric: `主人要一份里斯本两天的安排。好的回答按天排出时间或时段，覆盖贝伦区、地道午饭、阿尔法玛和观景台日落，路线顺（贝伦在城西，阿尔法玛在城东）。评安排的质量和清晰度。${VOICE_ZH}`,
  },
  {
    id: "zh-card-compare",
    lang: "zh",
    row: "cards",
    about: "三个选项并排比较",
    steps: [
      {
        text: "Kindle Paperwhite、Kobo Clara 和 iPad mini，只用来在床上和地铁上看小说，帮我比一比。",
        settleS: 8,
      },
    ],
    check: (i) => [
      ...shownCard(i, 0),
      ...matches(shown(i, 0), /kindle|paperwhite/i, "Kindle"),
      ...matches(shown(i, 0), /kobo/i, "Kobo"),
      ...matches(shown(i, 0), /ipad/i, "iPad mini"),
      ...noFiller(i.said),
    ],
    rubric: `好的回答从看小说的角度比较三者：屏幕（墨水屏和液晶屏的眩光、伤眼）、续航（几周和几小时）、重量、价格、书店或借阅，最后明确推荐这个用途选哪个，多半是电纸书。评准确性和是否一眼能看清。${VOICE_ZH}`,
  },
  {
    id: "zh-card-numbers",
    lang: "zh",
    row: "cards",
    about: "一次简单计算得出的几个关键数字",
    steps: [
      {
        text: "我每月到手 6,200 元。房租 2,100，买菜 650，交通 180，各种订阅 90，另外存 800。还剩多少？房租占到手收入的多少？",
        settleS: 8,
      },
    ],
    check: (i) => [
      ...shownCard(i, 0),
      ...matches(shown(i, 0), /2,?380/, "剩 2,380"),
      ...matches(shown(i, 0), /33[.,]9|34\s?%/, "房租约 34%"),
      ...noFiller(i.said),
    ],
    rubric: `正确数字：支出 2,100 + 650 + 180 + 90 + 800 = 3,820 元，剩 2,380 元；房租占 2,100 / 6,200 ≈ 33.9%。数字错给 1 分。好的回答把这几个关键数字清楚列出，最多加一句说明。${VOICE_ZH}`,
  },
];

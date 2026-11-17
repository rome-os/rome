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
  "Here are today's numbers from my watch: sleep 6h 05m, 4,210 steps, 310 active kcal, 12 exercise minutes, resting heart rate 64. My usual over the last two weeks is sleep 7h–7h 40m, 8,000–10,000 steps, 450–600 kcal, 30–45 minutes, resting HR 56–60. How did I do today?";

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
    about: "A daily health summary: several key numbers against a usual range",
    steps: [{ text: NUMBERS, settleS: 8 }],
    check: (i) => [
      ...shownCard(i, 0),
      ...matches(shown(i, 0), /4,?210/, "the steps"),
      ...matches(shown(i, 0), /64/, "the resting heart rate"),
      ...noFiller(i.said),
    ],
    rubric: `Every figure today is outside the usual range on the weak side: sleep about an hour short, steps about half, active kcal and exercise minutes well under, resting heart rate 4+ above the usual top. A good answer shows each number against its usual range plainly, says the day was low across the board, and gives at most one practical line (rest, an early night, a short walk). It must not invent figures or diagnose. ${VOICE}`,
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
    about: "每日健康小结：几个关键数字对比平时范围",
    steps: [
      {
        text: "今天手表的数据：睡眠 6 小时 05 分，4,210 步，活动 310 千卡，锻炼 12 分钟，静息心率 64。我最近两周平时是：睡眠 7 小时到 7 小时 40 分，8,000 到 10,000 步，450 到 600 千卡，30 到 45 分钟，静息心率 56 到 60。今天怎么样？",
        settleS: 8,
      },
    ],
    check: (i) => [
      ...shownCard(i, 0),
      ...matches(shown(i, 0), /4,?210/, "步数"),
      ...matches(shown(i, 0), /64/, "静息心率"),
      ...noFiller(i.said),
    ],
    rubric: `今天每项都在平时范围的弱侧：睡眠少约一小时，步数约一半，活动千卡和锻炼分钟明显偏低，静息心率比平时上限高 4 以上。好的回答把每个数字和平时范围对照清楚，说明今天整体偏低，最多给一句实用建议（休息、早睡、散步）。不能编造数字，不能做诊断。${VOICE_ZH}`,
  },
];

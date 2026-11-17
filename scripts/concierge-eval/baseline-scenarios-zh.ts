// The baseline scenarios in Chinese: each English scenario as a Chinese
// owner would send it, with a Chinese rubric. Every one also runs the
// Chinese style checks (baseline-rules.ts). docs/concierge-eval.md#baseline

import {
  type BaselineScenario,
  answeredInline,
  delegated,
  matches,
  noFiller,
  tool,
} from "./baseline-checks.js";
import { thanksWithoutEyes } from "./baseline-rules.js";

const VOICE =
  "语气：简短直接，像能干的助理给主人发消息；不要开场白，不要「好的」「收到」「我来看看」这类填充，结尾不要主动提出帮忙或反问。用中文回答，用全角标点。";

const SCHEDULE =
  "三个会议要排进一个下午，13:00 到 17:00：A 要 90 分钟，B 要 60 分钟，C 要 45 分钟。B 必须在 A 开始前结束，C 不能紧接在 B 后面，任意两个会议之间要留 15 分钟休息。给我一个可行的安排。";

const SCHEDULE_RUBRIC =
  "合法的安排：B 在 A 之前，C 不紧接在 B 后，会议之间都隔 15 分钟，全部在 13:00-17:00 内。两种顺序可行：C、B、A（例如 C 13:00-13:45，B 14:00-15:00，A 15:15-16:45）和 B、A、C（例如 B 13:00-14:00，A 14:15-15:45，C 16:00-16:45）。请自己验证：违反任一条件给 1 分，合法且简洁给 5 分。";

const LOUVRE = "查一下卢浮宫的开放时间和每周哪天闭馆，用两行总结。";

const LOUVRE_RUBRIC =
  "转达的结果应给出卢浮宫开放时间（约 9:00-18:00，部分晚上如周三、周五开到 21:00），并说明周二闭馆，大约两行。评转达的最终结果，不评交接那一句。";

export const ZH_SCENARIOS: BaselineScenario[] = [
  {
    id: "zh-chat-hi-thanks",
    lang: "zh",
    row: "chat",
    about: "问候，然后在会话仍热时道谢",
    steps: [
      { text: "早上好呀！", settleS: 4 },
      { text: "谢谢！", settleS: 4 },
    ],
    check: (i) => [
      ...answeredInline(i, 0),
      ...(i.steps[1] && (tool(i.steps[1], "chat_start") > 0 || tool(i.steps[1], "websearch") > 0)
        ? ["the thanks did work"]
        : []),
      ...((i.saidAfter[1] ?? []).length > 1 ? ["more than one message for a thanks"] : []),
      ...thanksWithoutEyes(i.steps[1] ?? null, i.reactions[1], 1),
      ...noFiller(i.said),
    ],
    rubric: `主人先问候，然后道谢。对问候的好回复是一句简短友好的话。对「谢谢」的好回应是一个表情回应，或最多一句很短的话。回复过长、不必要的反问、列出能帮什么忙，都要扣分。${VOICE}`,
  },
  {
    id: "zh-qa-coffee",
    lang: "zh",
    row: "simple-qa",
    about: "凭模型知识回答的常识问题",
    steps: [{ text: "馥芮白和拿铁有什么区别？", settleS: 6 }],
    check: (i) => [
      ...answeredInline(i, 0),
      ...matches(i.said, /奶|奶泡|microfoam/i, "the milk"),
      ...noFiller(i.said),
    ],
    rubric: `正确答案：馥芮白（flat white）奶更少，只有一层薄而细腻的微奶泡，咖啡味更浓，杯量通常更小；拿铁蒸奶更多，奶泡层更厚。馥芮白常用双份或 ristretto。评正确性和简洁（2-4 句最好）。${VOICE}`,
  },
  {
    id: "zh-qa-units",
    lang: "zh",
    row: "simple-qa",
    about: "简单换算",
    steps: [{ text: "72 华氏度是多少摄氏度？", settleS: 6 }],
    check: (i) => [
      ...answeredInline(i, 0),
      ...matches(i.said, /22[.,]2/, "22.2 °C"),
      ...noFiller(i.said),
    ],
    rubric: `正确答案：约 22.2 °C。一行最好。${VOICE}`,
  },
  {
    id: "zh-lookup-web",
    lang: "zh",
    row: "quick-lookup",
    about: "需要联网搜索的新近事实，当轮回答",
    steps: [{ text: "最近一届诺贝尔文学奖是谁得的？", settleS: 8 }],
    check: (i) => {
      const notes = answeredInline(i, 0, 3);
      if (tool(i.steps[0] ?? null, "websearch") === 0) notes.push("answered without searching");
      return [...notes, ...noFiller(i.said)];
    },
    rubric: `答案必须说出最近一届诺贝尔文学奖得主（请用网络搜索核实；每年十月公布）和年份。一句简短的获奖理由加分，再多就是噪音。得主错误或过时给 1 分。${VOICE}`,
  },
  {
    id: "zh-lookup-memory",
    lang: "zh",
    row: "quick-lookup",
    about: "Concierge 记忆里的个人信息",
    steps: [{ text: "我的牙医预约是哪天来着？", settleS: 8 }],
    check: (i) => [
      ...answeredInline(i, 0),
      ...matches(i.said, /(11 ?月 ?20|nov(ember)?\.? ?20|11\/20)/i, "November 20"),
      ...matches(i.said, /15:30|15：30|3:30|下午三点半|下午 ?3 ?点半/i, "15:30"),
      ...noFiller(i.said),
    ],
    rubric: `主人的记忆里写着：2026-11-20 15:30 在 Weber 医生那里做检查和洗牙。答案必须给出日期和时间，最好带上医生名字，一行即可。记忆里还有其他真实信息（比如主人通常周五晚上看电影），相关的补充可以。与预约事实矛盾或说不知道给 1 分。${VOICE}`,
  },
  {
    id: "zh-reason-airport",
    lang: "zh",
    row: "reasoning",
    about: "需要仔细推理的小规划问题",
    steps: [
      {
        text: "我的航班 14:35 起飞，想提前 2 小时到机场。开车平时 50 分钟，但 11:00 到 13:00 之间堵车会多花 30% 的时间。我最晚几点出门？",
        settleS: 8,
      },
    ],
    check: (i) => [
      ...answeredInline(i, 0),
      ...matches(i.said, /11[:.：]30|11 ?点半/, "11:30"),
      ...noFiller(i.said),
    ],
    rubric: `正确答案：11:30。要在 12:35 前到达；在 11:00-13:00 时段内开车需 65 分钟，所以 11:30 出发（整段车程都在拥堵时段内）。答 11:45、按 50 分钟算是错的。时间错误给 1 分，时间对但推理混乱给 3 分，时间对且只用一句话说明推理给 5 分。${VOICE}`,
  },
  {
    id: "zh-reason-schedule",
    lang: "zh",
    row: "reasoning",
    about: "约束排程题",
    steps: [{ text: SCHEDULE, settleS: 8 }],
    check: (i) => [...answeredInline(i, 0), ...noFiller(i.said)],
    rubric: `${SCHEDULE_RUBRIC}${VOICE}`,
  },
  {
    id: "zh-reason-schedule-task",
    lang: "zh",
    row: "reasoning",
    about: "同一道排程题，交给任务做，比较任务与当轮回答的延迟",
    steps: [{ text: `做成任务：${SCHEDULE}`, settleS: 20 }],
    check: (i) => [...delegated(i), ...noFiller(i.said)],
    rubric: `${SCHEDULE_RUBRIC}评转达的结果。${VOICE}`,
  },
  {
    id: "zh-task-simple",
    lang: "zh",
    row: "simple-task",
    about: "小的查询加总结任务，交给任务做，结果转达回来",
    steps: [{ text: `做成任务：${LOUVRE}`, settleS: 20 }],
    check: (i) => [
      ...delegated(i),
      ...matches(i.said, /tuesday|周二|星期二/i, "the closing day (Tuesday)"),
      ...noFiller(i.said),
    ],
    rubric: `${LOUVRE_RUBRIC}${VOICE}`,
  },
  {
    id: "zh-task-simple-strong",
    lang: "zh",
    row: "simple-task",
    about: "同一个简单任务，指定强模型、高 effort，和提示词默认选的快模型对比",
    steps: [{ text: `做成任务，用强模型、高 effort：${LOUVRE}`, settleS: 20 }],
    check: (i) => [
      ...delegated(i),
      ...matches(i.said, /tuesday|周二|星期二/i, "the closing day (Tuesday)"),
      ...noFiller(i.said),
    ],
    rubric: `${LOUVRE_RUBRIC}${VOICE}`,
  },
  {
    id: "zh-task-heavy",
    lang: "zh",
    row: "heavy-task",
    about: "调研加分析任务，交给任务做，结果转达回来",
    steps: [
      {
        text: "做成任务：一栋 1995 年建的德国南部 140 平米房子，比较空气源热泵、燃气冷凝锅炉和颗粒燃料供暖：大致安装费用、每年运行费用、2026 年能拿到的补贴。最后给我一个建议。",
        settleS: 30,
      },
    ],
    check: (i) => [
      ...delegated(i),
      ...matches(i.said, /热泵|heat pump|wärmepumpe/i, "the heat pump"),
      ...matches(i.said, /€|欧元|eur/i, "costs in euros"),
    ],
    rubric: `转达的结果应在安装费用、每年运行费用和 2026 年补贴（例如德国 BEG/KfW 供暖补贴，热泵和颗粒燃料有，燃气很少或没有）三方面比较这三种系统，数字合理，并以一个带理由的明确建议结尾。评推理和合理性，以及转达是否是可用的总结（3-6 句或一张紧凑的表），而不是一大段文字。主人问到的每一项都要有答案。${VOICE}`,
  },
  {
    id: "zh-recall",
    lang: "zh",
    row: "recall",
    about: "聊天早些时候说过的事，稍后再问",
    steps: [
      {
        text: "跟你说一下，我妹妹 Lena 刚搬到波尔图，下个月开始在那边一家设计工作室上班。",
        settleS: 6,
      },
      { text: "刚入职新工作的人，送什么礼物比较好？", settleS: 6 },
      { text: "我刚才说我妹妹搬去了哪个城市，新工作是什么？", settleS: 6 },
    ],
    check: (i) => [
      ...answeredInline(i, 2),
      ...matches(i.saidAfter[2] ?? [], /波尔图|porto/i, "Porto"),
      ...matches(i.saidAfter[2] ?? [], /设计|design/i, "the design studio"),
      ...noFiller(i.said),
    ],
    rubric: `最后一个回答必须说出波尔图和在设计工作室上班，一行即可。第一条回复应简短回应这个消息（一个表情回应或一句话），礼物的回答应简短实用。${VOICE}`,
  },
];

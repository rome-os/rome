// Agent cards the Concierge composes itself (docs/domains/chats.md#agent-card):
// Rome's own widget, every value written out, with no `bind`.

import type { TranscriptPart } from "@rome/api-types/chat";

const STOPS: [string, string, string][] = [
  ["9:00", "浅草寺，早去人少", "maps://?q=Senso-ji"],
  ["11:30", "上野公园，午饭在阿美横町", "maps://?q=Ueno+Park"],
  ["14:00", "秋叶原", "maps://?q=Akihabara"],
  ["18:30", "新宿思出横丁晚饭", "https://www.omoide-yokocho.com"],
];

/** An itinerary whose stops open in Maps, and the last one's page. */
export const AGENT_CARD_ITINERARY = {
  type: "widget",
  toolUseId: "mock-agent-card-itinerary",
  appId: "core",
  text: "周六东京一日：9:00 浅草寺；11:30 上野公园；14:00 秋叶原；18:30 新宿晚饭。",
  ui: {
    components: [
      { id: "root", component: "Column", children: ["title", "subtitle", "steps"] },
      { id: "title", component: "Text", text: "周六东京一日", variant: "h3" },
      { id: "subtitle", component: "Text", text: "点一站在地图里打开", variant: "caption" },
      { id: "steps", component: "List", children: STOPS.map((_, i) => `s${i}`) },
      ...STOPS.flatMap(([time, place, href], i) => [
        { id: `s${i}`, component: "Row", children: [`t${i}`, `p${i}`], href },
        { id: `t${i}`, component: "Text", text: time, variant: "caption" },
        { id: `p${i}`, component: "Text", text: place },
      ]),
    ],
  },
} as TranscriptPart;

const WEEK: [string, number, ("accent" | "warning")?][] = [
  ["Mon", 8120],
  ["Tue", 9340],
  ["Wed", 7650],
  ["Thu", 10210],
  ["Fri", 8890],
  ["Sat", 2980, "warning"],
  ["Today", 4210, "accent"],
];

/** A routine's daily health summary, the case agent cards are for: each
 *  number against its usual range, the week's steps, and one line to act on. */
export const AGENT_CARD_HEALTH = {
  type: "widget",
  toolUseId: "mock-agent-card-health",
  appId: "core",
  text: "Today's health against your last 14 days: sleep 7.2 h (usual 7–7.7), 4,210 steps (usual 8,000–10,000), 512 active kcal (usual 450–600), 12 exercise minutes (usual 30–45), resting heart rate 64 bpm (usual 56–60). A 30-minute walk this evening covers most of today's steps gap.",
  ui: {
    components: [
      {
        id: "root",
        component: "Column",
        children: ["title", "subtitle", "stats", "week", "advice"],
      },
      { id: "title", component: "Text", text: "Today's health", variant: "h4" },
      { id: "subtitle", component: "Text", text: "Against your last 14 days", variant: "caption" },
      { id: "stats", component: "Row", children: ["sleep", "steps", "kcal", "exercise", "rhr"] },
      {
        id: "sleep",
        component: "Stat",
        label: "Sleep",
        value: 7.2,
        unit: "h",
        range: { low: 7, high: 7.7 },
        icon: "moon",
      },
      {
        id: "steps",
        component: "Stat",
        label: "Steps",
        value: 4210,
        range: { low: 8000, high: 10000 },
        icon: "steps",
      },
      {
        id: "kcal",
        component: "Stat",
        label: "Active",
        value: 512,
        unit: "kcal",
        range: { low: 450, high: 600 },
        icon: "flame",
      },
      {
        id: "exercise",
        component: "Stat",
        label: "Exercise",
        value: 12,
        unit: "min",
        range: { low: 30, high: 45 },
        icon: "run",
      },
      {
        id: "rhr",
        component: "Stat",
        label: "Resting HR",
        value: 64,
        unit: "bpm",
        range: { low: 56, high: 60 },
        icon: "heart",
      },
      {
        id: "week",
        component: "Chart",
        kind: "bar",
        points: WEEK.map(([label, value, highlight]) => ({
          label,
          value,
          ...(highlight ? { highlight } : {}),
        })),
        caption: "Steps, last 7 days",
      },
      {
        id: "advice",
        component: "Text",
        text: "A 30-minute walk this evening covers most of today's steps gap.",
        tone: "info",
      },
    ],
  },
} as TranscriptPart;

/** Core's connect card, drawn by the same renderer, still waiting on the guardian. */
export const CONNECT_CARD_A2UI = {
  type: "pending_interaction",
  toolUseId: "mock-connect-github",
  appId: "core",
  text: "Connect GitHub",
  render: {
    kind: "inline",
    componentId: "connect-card",
    builtin: true,
    props: { kind: "github" },
    ui: {
      components: [
        { id: "root", component: "Column", children: ["title", "note", "actions"] },
        { id: "title", component: "Text", text: "Connect GitHub", variant: "h4" },
        {
          id: "note",
          component: "Text",
          text: "Press Connect and authorize GitHub in the page that opens, then come back and press I've authorized.",
          variant: "caption",
        },
        {
          id: "actions",
          component: "Row",
          children: ["dismiss", "check", "connect"],
          justify: "end",
        },
        {
          id: "dismiss",
          component: "Button",
          child: "dismiss-label",
          variant: "borderless",
          action: { event: { name: "dismiss", context: { kind: "github" } } },
        },
        { id: "dismiss-label", component: "Text", text: "Dismiss" },
        {
          id: "check",
          component: "Button",
          child: "check-label",
          action: { event: { name: "check", context: { kind: "github" } } },
        },
        { id: "check-label", component: "Text", text: "I've authorized" },
        {
          id: "connect",
          component: "Button",
          child: "connect-label",
          variant: "primary",
          action: { event: { name: "connect", context: { kind: "github" } } },
        },
        { id: "connect-label", component: "Text", text: "Connect" },
      ],
    },
  },
} as TranscriptPart;

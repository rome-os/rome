// Agent cards the Concierge composes itself (docs/domains/chats.md#agent-card):
// Rome's own widget, every value written out, with no `bind`.

import type { TranscriptPart } from "@rome/api-types/chat";

export const AGENT_CARD_ITINERARY = {
  type: "widget",
  toolUseId: "mock-agent-card-itinerary",
  appId: "core",
  text: "周六东京一日：9:00 浅草寺；11:30 上野公园；14:00 秋叶原；18:30 新宿晚饭。",
  ui: {
    components: [
      { id: "root", component: "Column", children: ["title", "steps"] },
      { id: "title", component: "Text", text: "周六东京一日", variant: "h3" },
      { id: "steps", component: "List", children: ["s1", "s2", "s3", "s4"] },
      { id: "s1", component: "Row", children: ["t1", "p1"] },
      { id: "t1", component: "Text", text: "9:00", variant: "caption" },
      { id: "p1", component: "Text", text: "浅草寺，早去人少" },
      { id: "s2", component: "Row", children: ["t2", "p2"] },
      { id: "t2", component: "Text", text: "11:30", variant: "caption" },
      { id: "p2", component: "Text", text: "上野公园，午饭在阿美横町" },
      { id: "s3", component: "Row", children: ["t3", "p3"] },
      { id: "t3", component: "Text", text: "14:00", variant: "caption" },
      { id: "p3", component: "Text", text: "秋叶原" },
      { id: "s4", component: "Row", children: ["t4", "p4"] },
      { id: "t4", component: "Text", text: "18:30", variant: "caption" },
      { id: "p4", component: "Text", text: "新宿思出横丁晚饭" },
    ],
  },
} as TranscriptPart;

/** A routine's daily health summary, the case agent cards are for. */
export const AGENT_CARD_HEALTH = {
  type: "widget",
  toolUseId: "mock-agent-card-health",
  appId: "core",
  text: "Today's health against your last 14 days: sleep 7h 12m, 8,432 steps, 512 active kcal, 38 exercise minutes, resting heart rate 58 bpm. A short walk after dinner gets you to 10,000 steps.",
  ui: {
    components: [
      {
        id: "root",
        component: "Column",
        children: ["title", "subtitle", "stats", "goal", "advice"],
      },
      { id: "title", component: "Text", text: "Today's health", variant: "h4" },
      { id: "subtitle", component: "Text", text: "Against your last 14 days", variant: "caption" },
      { id: "stats", component: "Row", children: ["sleep", "steps", "kcal", "exercise", "rhr"] },
      {
        id: "sleep",
        component: "Stat",
        label: "Sleep",
        value: "7h 12m",
        caption: "Usual 6h 40m–7h 50m",
      },
      { id: "steps", component: "Stat", label: "Steps", value: 8432, caption: "Usual 6,900–9,800" },
      {
        id: "kcal",
        component: "Stat",
        label: "Active",
        value: 512,
        unit: "kcal",
        caption: "Usual 380–560",
      },
      {
        id: "exercise",
        component: "Stat",
        label: "Exercise",
        value: 38,
        unit: "min",
        caption: "Usual 20–45",
      },
      {
        id: "rhr",
        component: "Stat",
        label: "Resting HR",
        value: 58,
        unit: "bpm",
        caption: "Usual 55–61",
      },
      { id: "goal", component: "Progress", value: 8432, max: 10000, label: "Steps goal" },
      {
        id: "advice",
        component: "Text",
        text: "A short walk after dinner gets you to 10,000 steps.",
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

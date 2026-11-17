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

export const AGENT_CARD_NUMBERS = {
  type: "widget",
  toolUseId: "mock-agent-card-numbers",
  appId: "core",
  text: "October: spent $3,180 of a $3,500 budget (91%). Rent $2,400, food $620, transport $160.",
  ui: {
    components: [
      { id: "root", component: "Column", children: ["title", "stats", "budget"] },
      { id: "title", component: "Text", text: "October spending", variant: "h3" },
      { id: "stats", component: "Row", children: ["rent", "food", "transport"] },
      { id: "rent", component: "Stat", label: "Rent", value: "2,400", unit: "USD" },
      { id: "food", component: "Stat", label: "Food", value: "620", unit: "USD" },
      { id: "transport", component: "Stat", label: "Transport", value: "160", unit: "USD" },
      {
        id: "budget",
        component: "Progress",
        value: 3180,
        max: 3500,
        label: "$3,180 of $3,500 budget",
      },
    ],
  },
} as TranscriptPart;

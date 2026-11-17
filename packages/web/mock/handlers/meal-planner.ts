import { HttpResponse, http } from "msw";
import type { TranscriptPart } from "@rome/api-types/chat";
import { questionCardRender } from "../fixtures/question-card";

// A meal planner app's API and the card it shows in Chat, described as data
// (`widget` with `ui`). The iOS demo data draws the same card.
let glasses = 3;

export const mealPlannerHandlers = [
  http.get("/api/apps/meal-planner/days/today", () =>
    HttpResponse.json({
      calories: 1240,
      goal: 2000,
      water: glasses,
      meals: [
        { name: "Oatmeal with blueberries", calories: "320 kcal" },
        { name: "Beef noodle soup", calories: "680 kcal" },
        { name: "Latte", calories: "240 kcal" },
      ],
    }),
  ),
  http.post("/api/apps/meal-planner/water", () => {
    glasses += 1;
    return HttpResponse.json({ water: glasses });
  }),
  // Core's events route. The meal card's water button reaches the app's
  // `water` above; any other widget's event is taken, as core takes an answer
  // (mock mode has no agent to start a turn for it).
  http.post("/api/chat/widgets/:widgetId/events", async ({ request }) => {
    const { name } = (await request.json()) as { name?: unknown };
    // Any other event stands for core answering the agent waiting on its widget.
    if (name !== "water") {
      return HttpResponse.json({ answered: true });
    }
    glasses += 1;
    return HttpResponse.json({ water: glasses });
  }),
];

const ids = (...list: string[]) => list;

export const mealPlannerCard = {
  type: "widget",
  toolUseId: "mock-meal-card",
  appId: "meal-planner",
  text: "Today's meals",
  bind: { "/today": "days/today" },
  ui: {
    components: [
      {
        id: "root",
        component: "Column",
        children: ids("title", "stats", "goal", "meals", "water"),
      },
      { id: "title", component: "Text", text: "Today's meals", variant: "h3" },
      { id: "stats", component: "Row", children: ids("kcal", "cups"), justify: "spaceBetween" },
      {
        id: "kcal",
        component: "Stat",
        label: "Calories",
        value: { path: "/today/calories" },
        unit: "kcal",
      },
      {
        id: "cups",
        component: "Stat",
        label: "Water",
        value: { path: "/today/water" },
        unit: "glasses",
      },
      {
        id: "goal",
        component: "Progress",
        label: "Daily goal 2,000 kcal",
        value: { path: "/today/calories" },
        max: { path: "/today/goal" },
      },
      { id: "meals", component: "List", children: { componentId: "meal", path: "/today/meals" } },
      {
        id: "meal",
        component: "Row",
        children: ids("meal-name", "meal-kcal"),
        justify: "spaceBetween",
      },
      { id: "meal-name", component: "Text", text: { path: "name" } },
      { id: "meal-kcal", component: "Text", text: { path: "calories" }, variant: "caption" },
      {
        id: "water",
        component: "Button",
        child: "water-label",
        action: { event: { name: "water" } },
      },
      { id: "water-label", component: "Text", text: "Log a glass of water" },
    ],
  },
} as TranscriptPart;

// `ask_question`'s card as core stores it: the question card's props, with
// the same card described as data in `render.ui`, which the dashboard draws.
export const dinnerQuestion = {
  type: "pending_interaction",
  toolUseId: "mock-dinner-question",
  appId: "core",
  render: questionCardRender([
    {
      id: "dinner",
      question: "What kind of dinner?",
      type: "single",
      options: ["High protein", "Something light"],
      optionDescriptions: {
        "High protein": "Chicken, tofu, eggs",
      },
      freeText: true,
    },
    {
      id: "avoid",
      question: "Anything to avoid?",
      type: "multi",
      options: ["Spicy", "Seafood", "Dairy"],
      optional: true,
    },
  ]),
} as TranscriptPart;

// An agent's own card from `show_card`: display only, with no app and no
// bindings, so it reads nothing and posts nothing.
export const healthSummaryCard = {
  type: "widget",
  toolUseId: "mock-health-card",
  appId: "core",
  text:
    "Daily health summary, Nov 15 10:01 p.m. to Nov 16 10:01 p.m.: sleep 7h 25m, 5,673 steps, " +
    "372 active kcal, 23 exercise minutes including a 22-minute run, resting heart rate 53 bpm " +
    "(usual 53 to 61). Sleep varied a lot last week: keep bed and wake times steady, and stop " +
    "screens 30 minutes before bed.",
  ui: {
    components: [
      {
        id: "root",
        component: "Column",
        children: ids("title", "period", "row1", "row2", "hl-title", "hl"),
      },
      { id: "title", component: "Text", variant: "h3", text: "Daily health summary" },
      {
        id: "period",
        component: "Text",
        variant: "caption",
        text: "Nov 15, 10:01 p.m. – Nov 16, 10:01 p.m.",
      },
      {
        id: "row1",
        component: "Row",
        justify: "spaceBetween",
        children: ids("sleep", "steps", "kcal"),
      },
      {
        id: "row2",
        component: "Row",
        justify: "spaceBetween",
        children: ids("exercise", "rhr", "spacer"),
      },
      { id: "sleep", component: "Stat", label: "Sleep", value: "7h 25m" },
      { id: "steps", component: "Stat", label: "Steps", value: "5,673" },
      { id: "kcal", component: "Stat", label: "Active", value: 372, unit: "kcal" },
      {
        id: "exercise",
        component: "Stat",
        label: "Exercise",
        value: 23,
        unit: "min",
        caption: "Incl. a 22 min run",
      },
      {
        id: "rhr",
        component: "Stat",
        label: "Resting HR",
        value: 53,
        unit: "bpm",
        caption: "Usual 53–61",
      },
      { id: "spacer", component: "Text", text: "" },
      { id: "hl-title", component: "Text", variant: "h5", text: "Worth your attention" },
      { id: "hl", component: "List", children: ids("hl1", "hl2") },
      {
        id: "hl1",
        component: "Text",
        text: "Sleep varied a lot last week. Keep bed and wake times steady.",
      },
      { id: "hl2", component: "Text", text: "Stop screens 30 minutes before bed." },
    ],
  },
} as TranscriptPart;

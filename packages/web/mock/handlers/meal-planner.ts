import { HttpResponse, http } from "msw";
import type { TranscriptPart } from "@rome/api-types/chat";

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

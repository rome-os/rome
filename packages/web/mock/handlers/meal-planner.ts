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

// `ask_question`'s card as core stores it: the question card's props, with
// the same card described as data in `render.ui`, which the dashboard draws.
export const dinnerQuestion = {
  type: "pending_interaction",
  toolUseId: "mock-dinner-question",
  appId: "core",
  render: {
    kind: "inline",
    componentId: "question-card",
    props: {
      questions: [
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
      ],
    },
    ui: {
      components: [
        {
          id: "q0-text",
          component: "Text",
          text: "What kind of dinner?",
          variant: "h5",
        },
        {
          id: "q0-title",
          component: "Row",
          children: ["q0-text"],
        },
        {
          id: "q0-pick",
          component: "ChoicePicker",
          variant: "mutuallyExclusive",
          options: [
            {
              label: "High protein",
              value: "High protein",
              description: "Chicken, tofu, eggs",
            },
            {
              label: "Something light",
              value: "Something light",
            },
          ],
          value: {
            path: "/answers/0/values",
          },
        },
        {
          id: "q0-own",
          component: "TextField",
          label: "What kind of dinner?",
          value: {
            path: "/answers/0/text",
          },
          variant: "shortText",
          placeholder: {
            string: "typeOwn",
          },
        },
        {
          id: "q0",
          component: "Column",
          children: ["q0-title", "q0-pick", "q0-own"],
        },
        {
          id: "q1-text",
          component: "Text",
          text: "Anything to avoid?",
          variant: "h5",
        },
        {
          id: "q1-optional",
          component: "Text",
          text: {
            string: "optional",
          },
          variant: "caption",
        },
        {
          id: "q1-title",
          component: "Row",
          children: ["q1-text", "q1-optional"],
        },
        {
          id: "q1-pick",
          component: "ChoicePicker",
          variant: "multipleSelection",
          options: [
            {
              label: "Spicy",
              value: "Spicy",
            },
            {
              label: "Seafood",
              value: "Seafood",
            },
            {
              label: "Dairy",
              value: "Dairy",
            },
          ],
          value: {
            path: "/answers/1/values",
          },
        },
        {
          id: "q1",
          component: "Column",
          children: ["q1-title", "q1-pick"],
        },
        {
          id: "send-label",
          component: "Text",
          text: {
            string: "send",
          },
        },
        {
          id: "send",
          component: "Button",
          child: "send-label",
          variant: "primary",
          action: {
            event: {
              name: "rome:answer",
              context: {
                answers: {
                  path: "/answers",
                },
              },
            },
          },
          checks: [
            {
              condition: {
                call: "or",
                args: {
                  values: [
                    {
                      call: "required",
                      args: {
                        value: {
                          path: "/answers/0/values",
                        },
                      },
                    },
                    {
                      call: "required",
                      args: {
                        value: {
                          path: "/answers/0/text",
                        },
                      },
                    },
                  ],
                },
              },
              message: "",
            },
          ],
        },
        {
          id: "dismiss-label",
          component: "Text",
          text: {
            string: "dismiss",
          },
        },
        {
          id: "dismiss",
          component: "Button",
          child: "dismiss-label",
          variant: "borderless",
          action: {
            event: {
              name: "rome:dismiss",
            },
          },
        },
        {
          id: "actions",
          component: "Row",
          children: ["dismiss", "send"],
          justify: "end",
        },
        {
          id: "root",
          component: "Column",
          children: ["q0", "q1", "actions"],
        },
      ],
      data: {
        answers: [
          {
            values: [],
            text: "",
          },
          {
            values: [],
            text: "",
          },
        ],
      },
    },
    builtin: true,
  },
} as TranscriptPart;

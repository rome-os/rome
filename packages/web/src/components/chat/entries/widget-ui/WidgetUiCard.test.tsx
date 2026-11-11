// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import "@/i18n";
import { parseEntries } from "../parse-entries";
import { renderFlatEntries } from "../render";

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

const ui = {
  components: [
    { id: "root", component: "Column", children: ["title", "calories", "goal", "meals", "water"] },
    { id: "title", component: "Text", text: "Today's meals", variant: "h3" },
    {
      id: "calories",
      component: "Stat",
      label: "Calories",
      value: { path: "/today/calories" },
      unit: "kcal",
    },
    {
      id: "goal",
      component: "Progress",
      label: "Goal",
      value: { path: "/today/calories" },
      max: { path: "/today/goal" },
    },
    { id: "meals", component: "List", children: { componentId: "meal", path: "/today/meals" } },
    { id: "meal", component: "Text", text: { path: "name" } },
    {
      id: "water",
      component: "Button",
      child: "water-label",
      action: { event: { name: "water", context: { date: "2026-11-11" } } },
    },
    { id: "water-label", component: "Text", text: "Log a glass of water" },
  ],
};

function stored() {
  return parseEntries(
    JSON.stringify([
      {
        type: "widget",
        toolUseId: "w-ui",
        appId: "meals",
        ui,
        bind: { "/today": "days/2026-11-11" },
        text: "Today's meals.",
      },
    ]),
  );
}

describe("a widget described as data", () => {
  it("draws its components with the data its app returns, and a press posts to the app", async () => {
    let calories = 1200;
    const fetch = rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") {
        return Response.json({ ok: true });
      }
      expect(url).toBe("/api/apps/meals/days/2026-11-11");
      return Response.json({
        calories,
        goal: 2000,
        meals: [{ name: "Oatmeal" }, { name: "Ramen" }],
      });
    });

    render(<>{renderFlatEntries(stored(), { sessionId: "s1" })}</>);

    await screen.findByText("Oatmeal");
    expect(screen.getByText("Ramen")).toBeTruthy();
    expect(screen.getByText("Today's meals")).toBeTruthy();
    expect(screen.getByText("Calories")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1200");

    fireEvent.click(screen.getByRole("button", { name: "Log a glass of water" }));
    await waitFor(() => expect(fetch.mock.calls.length).toBe(3));
    const post = fetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(String(post?.[0])).toBe("/api/apps/meals/water");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ date: "2026-11-11" });
  });

  it("keeps a widget part with neither a component nor a description out of the transcript", () => {
    expect(
      parseEntries(JSON.stringify([{ type: "widget", toolUseId: "w", appId: "meals", text: "x" }])),
    ).toEqual([]);
  });
});

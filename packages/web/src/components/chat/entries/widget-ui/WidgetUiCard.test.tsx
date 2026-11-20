// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import { ThemeProvider } from "@/hooks/use-theme";
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

    render(<>{renderFlatEntries(stored(), { sessionId: "s1", messageId: "m-ui" })}</>);

    await screen.findByText("Oatmeal");
    expect(screen.getByText("Ramen")).toBeTruthy();
    expect(screen.getByText("Today's meals")).toBeTruthy();
    expect(screen.getByText("Calories")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1200");

    // The data draws before the first read settles and turns the button on,
    // so a click on the first frame with data would hit a disabled button.
    const button = screen.getByRole("button", { name: "Log a glass of water" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    calories = 1450;
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1450"),
    );
    const posts = fetch.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    // The press goes to core, which calls the app.
    expect(String(posts[0]?.[0])).toBe("/api/chat/widgets/m-ui/events");
    expect(JSON.parse(String(posts[0]?.[1]?.body))).toMatchObject({
      name: "water",
      context: { date: "2026-11-11" },
    });
    expect(fetch.mock.calls.filter(([, init]) => init?.method !== "POST")).toHaveLength(2);
  });

  it("draws Markdown that opens and loads nothing: links, images, raw HTML and diagrams", async () => {
    const fetch = rs.spyOn(globalThis, "fetch");
    render(
      <MemoryRouter>
        <ThemeProvider>
          {renderFlatEntries(
            parseEntries(
              JSON.stringify([
                {
                  type: "widget",
                  toolUseId: "w-md",
                  appId: "core",
                  text: "Sleep was good.",
                  ui: {
                    components: [
                      {
                        id: "root",
                        component: "Markdown",
                        text: [
                          "**Sleep** was good. See [the CDC](https://www.cdc.gov/sleep/).",
                          "![a chart](https://example.com/chart.png)",
                          '<img src="https://example.com/raw.png" alt="raw"> <a href="https://example.com/raw">raw link</a>',
                          "```mermaid",
                          'flowchart LR\n  A@{ img: "https://example.com/p.png" }\n  click A "https://example.com/open"',
                          "```",
                          "| Day | Hours |\n| --- | --- |\n| Mon | 7h |",
                          "```\nconst x = 1;\n```",
                        ].join("\n\n"),
                      },
                    ],
                  },
                },
              ]),
            ),
            { sessionId: "s1" },
          )}
        </ThemeProvider>
      </MemoryRouter>,
    );

    const bold = await screen.findByText("Sleep");
    expect(bold.getAttribute("data-streamdown")).toBe("strong");
    expect(screen.getByText("the CDC").closest("a")).toBeNull();
    expect(screen.getByText("a chart")).toBeTruthy();
    // The diagram stays its source, so it draws no SVG with links or images.
    expect(await screen.findByText(/click A/)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector("img, image, svg a, a[href]")).toBeNull();
    // Tables and code get no copy, download or fullscreen buttons.
    expect(screen.getByText("Mon")).toBeTruthy();
    expect(document.querySelector("button")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a widget part with neither a component nor a description out of the transcript", () => {
    expect(
      parseEntries(JSON.stringify([{ type: "widget", toolUseId: "w", appId: "meals", text: "x" }])),
    ).toEqual([]);
  });

  it("sends one press at a time, so a second press while the first is in flight sends nothing", async () => {
    let release: () => void = () => {};
    const fetch = rs.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (init?.method === "POST") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return Response.json({ ok: true });
      }
      return Response.json({ calories: 1, goal: 2, meals: [] });
    });
    render(<>{renderFlatEntries(stored(), { sessionId: "s1" })}</>);
    const button = await screen.findByRole("button", { name: "Log a glass of water" });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    release();
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("shows its fallback line, and leaves the rest of the chat drawn, for a card A2UI refuses", async () => {
    rs.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    const refused = (toolUseId: string, ui: unknown) => ({
      type: "widget",
      toolUseId,
      appId: "meals",
      ui,
      text: "Today's meals.",
    });
    render(
      <MemoryRouter>
        <ThemeProvider>
          {renderFlatEntries(
            parseEntries(
              JSON.stringify([
                refused("w-ctor", {
                  components: [{ id: "root", component: "Text", text: { path: "/constructor" } }],
                }),
                refused("w-ctx", {
                  components: [
                    {
                      id: "root",
                      component: "Button",
                      child: "l",
                      action: { event: { name: "water", context: { meal: { id: 42 } } } },
                    },
                    { id: "l", component: "Text", text: "Go" },
                  ],
                }),
                refused("w-empty", {}),
                { type: "text", content: "Still here" },
              ]),
            ),
            { sessionId: "s1" },
          )}
        </ThemeProvider>
      </MemoryRouter>,
    );
    expect(await screen.findAllByText(/Could not show this card/)).toHaveLength(3);
    expect(screen.getByText("Still here")).toBeTruthy();
  });

  it("checks a stored card again before it draws or calls the app", async () => {
    const fetch = rs.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    const button = (name: string) => ({
      components: [
        { id: "root", component: "Button", child: "l", action: { event: { name } } },
        { id: "l", component: "Text", text: "Go" },
      ],
    });
    render(
      <>
        {renderFlatEntries(
          parseEntries(
            JSON.stringify([
              {
                type: "widget",
                toolUseId: "a",
                appId: "meals",
                ui: ui,
                bind: { "/today": "../../settings" },
                text: "a",
              },
              {
                type: "widget",
                toolUseId: "b",
                appId: "meals",
                ui: button("../../approvals/x/approve"),
                text: "b",
              },
              {
                type: "widget",
                toolUseId: "c",
                appId: "..",
                ui: ui,
                bind: { "/today": "days/1" },
                text: "c",
              },
            ]),
          ),
          { sessionId: "s1" },
        )}
      </>,
    );
    expect(await screen.findAllByText(/Could not show this card/)).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Go" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps buttons off until the first read lands, and lets only the newest read write", async () => {
    let water = 3;
    let releaseFirst: (r: Response) => void = () => {};
    let gets = 0;
    const fetch = rs.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (init?.method === "POST") {
        water += 1;
        return Response.json({ ok: true });
      }
      gets += 1;
      const body = { calories: 1200, goal: 2000, water, meals: [] };
      if (gets === 1)
        return new Promise<Response>((r) => {
          releaseFirst = r;
        });
      return Response.json(body);
    });
    render(<>{renderFlatEntries(stored(), { sessionId: "s1" })}</>);
    const button = await screen.findByRole("button", { name: "Log a glass of water" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(fetch.mock.calls.filter(([, i]) => i?.method === "POST")).toHaveLength(0);

    releaseFirst(Response.json({ calories: 1100, goal: 2000, water: 3, meals: [] }));
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  });

  it("shows what the read after a press returns", async () => {
    const pending: Array<(r: Response) => void> = [];
    rs.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (init?.method === "POST") return Response.json({ ok: true });
      return new Promise<Response>((r) => pending.push(r));
    });
    render(<>{renderFlatEntries(stored(), { sessionId: "s1" })}</>);
    await waitFor(() => expect(pending).toHaveLength(1));
    // The first read finishes, then a press starts a second one.
    pending[0](Response.json({ calories: 1, goal: 2, meals: [{ name: "First" }] }));
    const button = await screen.findByRole("button", { name: "Log a glass of water" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(pending).toHaveLength(2));
    pending[1](Response.json({ calories: 1, goal: 2, meals: [{ name: "Newest" }] }));
    expect(await screen.findByText("Newest")).toBeTruthy();
  });

  it("draws a stat against its range, a bar chart, a callout and rows that open links", async () => {
    const fetch = rs.spyOn(globalThis, "fetch");
    render(
      <MemoryRouter>
        <ThemeProvider>
          {renderFlatEntries(
            parseEntries(
              JSON.stringify([
                {
                  type: "widget",
                  toolUseId: "w-health",
                  appId: "core",
                  text: "Resting HR 64, over 56–60.",
                  ui: {
                    components: [
                      {
                        id: "root",
                        component: "Column",
                        children: ["rhr", "sleep", "week", "tip", "stop", "page"],
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
                        id: "sleep",
                        component: "Stat",
                        label: "Sleep",
                        value: 7.2,
                        unit: "h",
                        range: { low: 7, high: 7.7 },
                      },
                      {
                        id: "week",
                        component: "Chart",
                        kind: "bar",
                        points: [
                          { label: "Mon", value: 8100 },
                          { label: "Today", value: 4210, highlight: "accent" },
                        ],
                        unit: "steps",
                      },
                      { id: "tip", component: "Text", text: "Rest tonight.", tone: "info" },
                      {
                        id: "stop",
                        component: "Row",
                        children: ["stop-name"],
                        href: "maps://?q=Belem+Tower",
                      },
                      { id: "stop-name", component: "Text", text: "Belém Tower" },
                      {
                        id: "page",
                        component: "Text",
                        text: "Opening hours",
                        href: "https://example.com/hours",
                      },
                    ],
                  },
                },
              ]),
            ),
            { sessionId: "s1" },
          )}
        </ThemeProvider>
      </MemoryRouter>,
    );
    // The reader, not the card, says where each value sits.
    expect(await screen.findByText("Usual 56–60 bpm")).toBeTruthy();
    expect(screen.getByText("High")).toBeTruthy();
    expect(screen.getByText("Normal")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Mon 8,100 steps, Today 4,210 steps" })).toBeTruthy();
    expect(screen.getByText("Rest tonight.")).toBeTruthy();
    // A place opens in Apple Maps, a page as itself; neither is an event.
    expect(screen.getByRole("link", { name: "Belém Tower" }).getAttribute("href")).toBe(
      "https://maps.apple.com/?q=Belem+Tower",
    );
    expect(screen.getByRole("link", { name: "Opening hours" }).getAttribute("href")).toBe(
      "https://example.com/hours",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  const drawCard = (components: unknown[]) =>
    render(
      <MemoryRouter>
        <ThemeProvider>
          {renderFlatEntries(
            parseEntries(
              JSON.stringify([
                { type: "widget", toolUseId: "w-x", appId: "core", text: "x", ui: { components } },
              ]),
            ),
            { sessionId: "s1" },
          )}
        </ThemeProvider>
      </MemoryRouter>,
    );

  it("keeps a link on a callout and on a row of stat tiles", async () => {
    rs.spyOn(globalThis, "fetch");
    drawCard([
      { id: "root", component: "Column", children: ["tip", "tiles"] },
      {
        id: "tip",
        component: "Text",
        text: "Read more",
        tone: "info",
        href: "https://example.com/tip",
      },
      { id: "tiles", component: "Row", children: ["a", "b"], href: "https://example.com/day" },
      { id: "a", component: "Stat", label: "Sleep", value: 7 },
      { id: "b", component: "Stat", label: "Steps", value: 8000 },
    ]);
    expect((await screen.findByRole("link", { name: "Read more" })).getAttribute("href")).toBe(
      "https://example.com/tip",
    );
    expect(screen.getByRole("link", { name: /Sleep.*Steps/ }).getAttribute("href")).toBe(
      "https://example.com/day",
    );
  });

  it("draws negative bars below a zero line, each as long as its value", async () => {
    rs.spyOn(globalThis, "fetch");
    drawCard([
      {
        id: "root",
        component: "Chart",
        kind: "bar",
        points: [
          { label: "Mon", value: -10 },
          { label: "Tue", value: -100 },
          { label: "Wed", value: 50 },
        ],
      },
    ]);
    const chart = await screen.findByRole("img", { name: "Mon -10, Tue -100, Wed 50" });
    const bars = [...chart.querySelectorAll("rect")].map((r) => ({
      y: Number(r.getAttribute("y")),
      h: Number(r.getAttribute("height")),
    }));
    const zero = Number(chart.querySelector("line")?.getAttribute("y1"));
    // Negative bars start at the zero line and go down; the positive one ends there.
    expect(bars[0]?.y).toBeCloseTo(zero);
    expect(bars[1]?.y).toBeCloseTo(zero);
    expect(bars[2]?.y + bars[2]?.h).toBeCloseTo(zero);
    // Sizes keep their ratio: -100 is ten times -10, and twice 50.
    expect(bars[1]?.h).toBeCloseTo(bars[0]!.h * 10);
    expect(bars[1]?.h).toBeCloseTo(bars[2]!.h * 2);
  });

  it("draws a chart of all zeros as flat bars on the baseline", async () => {
    rs.spyOn(globalThis, "fetch");
    drawCard([
      {
        id: "root",
        component: "Chart",
        kind: "bar",
        points: [
          { label: "Mon", value: 0 },
          { label: "Tue", value: 0 },
        ],
      },
    ]);
    const chart = await screen.findByRole("img", { name: "Mon 0, Tue 0" });
    for (const rect of chart.querySelectorAll("rect")) {
      expect(Number(rect.getAttribute("y"))).toBeGreaterThanOrEqual(0);
    }
  });
});

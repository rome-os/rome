// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import "@/i18n";
import { parseEntries } from "../parse-entries";
import { renderFlatEntries } from "../render";
import { READ_ONLY_WIDGET_HOST, WidgetHostContext } from "./turn-fields";
import { WidgetUiCard } from "./WidgetUiCard";

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

/** The events the card sends to core, which takes each one. */
function captureEvents() {
  const events: { url: string; body: { name: string; context: unknown } }[] = [];
  rs.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    events.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  });
  return events;
}

// The shape core's `questionCardUi` builds for one single-choice question.
const ui = {
  components: [
    { id: "q0-text", component: "Text", text: "Which tone?", variant: "h5" },
    { id: "q0-title", component: "Row", children: ["q0-text"] },
    {
      id: "q0-pick",
      component: "ChoicePicker",
      variant: "mutuallyExclusive",
      options: [
        { label: "Warm", value: "Warm" },
        { label: "Plain", value: "Plain", description: "Short sentences" },
      ],
      value: { path: "/answers/0/values" },
      clears: { path: "/answers/0/text" },
    },
    {
      id: "q0-own",
      component: "TextField",
      label: "Which tone?",
      value: { path: "/answers/0/text" },
      placeholder: { string: "typeOwn" },
      clears: { path: "/answers/0/values" },
    },
    { id: "q0", component: "Column", children: ["q0-title", "q0-pick", "q0-own"] },
    {
      id: "app-post",
      component: "Button",
      child: "app-post-label",
      action: { event: { name: "anything" } },
    },
    { id: "app-post-label", component: "Text", text: "App post" },
    { id: "send-label", component: "Text", text: { string: "send" } },
    {
      id: "send",
      component: "Button",
      child: "send-label",
      variant: "primary",
      action: { event: { name: "send", context: { answers: { path: "/answers" } } } },
      checks: [
        {
          condition: {
            call: "or",
            args: {
              values: [
                { call: "required", args: { value: { path: "/answers/0/values" } } },
                { call: "required", args: { value: { path: "/answers/0/text" } } },
              ],
            },
          },
          message: "",
        },
      ],
    },
    { id: "dismiss-label", component: "Text", text: { string: "dismiss" } },
    {
      id: "dismiss",
      component: "Button",
      child: "dismiss-label",
      variant: "borderless",
      action: { event: { name: "dismiss" } },
    },
    { id: "actions", component: "Row", children: ["dismiss", "send"], justify: "end" },
    { id: "root", component: "Column", children: ["q0", "app-post", "actions"] },
  ],
  data: { answers: [{ values: [], text: "" }] },
} as never;

describe("a question card described as data", () => {
  it("answers the waiting turn with what the guardian picked, once a required question has an answer", async () => {
    const events = captureEvents();
    render(<WidgetUiCard widgetId="m1" toolUseId="q1" appId="core" ui={ui} text="" waiting={{}} />);

    const send = await screen.findByRole("button", { name: "Send" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Short sentences")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Plain/ }));
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);

    await waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]?.url).toBe("/api/chat/widgets/m1/events");
    expect(events[0]?.body.name).toBe("send");
    expect(events[0]?.body.context).toEqual({ answers: [{ values: ["Plain"], text: "" }] });
    // Core took it: the card waits for the stored answer, read-only.
    expect(await screen.findByText("Sent")).toBeTruthy();
  });

  it("stays usable when core does not take the event", async () => {
    rs.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 500 }));
    render(<WidgetUiCard widgetId="m1" toolUseId="q1" appId="core" ui={ui} text="" waiting={{}} />);
    const send = await screen.findByRole("button", { name: "Send" });
    fireEvent.click(screen.getByRole("button", { name: /Plain/ }));
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);
    // Nothing locks: Send and the options work again, and the card says it failed.
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText("Sent")).toBeNull();
    expect((screen.getByRole("button", { name: /Warm/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("says the send failed, not that the card's data could not be read", async () => {
    rs.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 500 }));
    render(<WidgetUiCard widgetId="m1" toolUseId="q1" appId="core" ui={ui} text="" waiting={{}} />);
    const send = await screen.findByRole("button", { name: "Send" });
    fireEvent.click(screen.getByRole("button", { name: /Plain/ }));
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);
    expect(await screen.findByText("Failed to send message.")).toBeTruthy();
    expect(screen.queryByText(/Could not read this card/)).toBeNull();
  });

  it("tells the view what core said, so the view reads the chat again", async () => {
    captureEvents();
    const heard: number[] = [];
    render(
      <WidgetHostContext.Provider
        value={{ turnFields: () => ({}), onSettled: (outcome) => heard.push(outcome.status) }}
      >
        <WidgetUiCard widgetId="m1" toolUseId="q1" appId="core" ui={ui} text="" waiting={{}} />
      </WidgetHostContext.Provider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(heard).toEqual([200]));
  });

  it("sends nothing from a view that only shows the chat", async () => {
    const events = captureEvents();
    render(
      <WidgetHostContext.Provider value={READ_ONLY_WIDGET_HOST}>
        <WidgetUiCard widgetId="m1" toolUseId="q1" appId="core" ui={ui} text="" waiting={{}} />
      </WidgetHostContext.Provider>,
    );
    // The card shows, locked: there is nothing to press.
    expect(await screen.findByText("Which tone?")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(events).toEqual([]);
  });

  it("shows an answered card read-only with what was sent", async () => {
    const { container } = render(
      <WidgetUiCard
        widgetId="m1"
        toolUseId="q1"
        appId="core"
        ui={ui}
        text=""
        waiting={{
          result: {
            answers: [{ questionId: "tone", value: "Warm" }],
            card: [{ values: ["Warm"], text: "" }],
          },
        }}
      />,
    );

    await screen.findByText("Answered");
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    const warm = screen.getByRole("button", { name: "Warm" });
    expect(warm.getAttribute("aria-pressed")).toBe("true");
    expect((warm as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector("[data-chat-pending-card]")).toBeNull();
  });

  it("lets the last of a pick and typed text win on a single choice", async () => {
    const events = captureEvents();
    render(<WidgetUiCard widgetId="m1" toolUseId="q2" appId="core" ui={ui} text="" waiting={{}} />);
    const own = await screen.findByRole("textbox", { name: "Which tone?" });
    fireEvent.change(own, { target: { value: "Friendly" } });
    fireEvent.click(screen.getByRole("button", { name: /Plain/ }));
    await waitFor(() => expect((own as HTMLInputElement).value).toBe(""));

    fireEvent.change(own, { target: { value: "Calm" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Plain/ }).getAttribute("aria-pressed")).toBe(
        "false",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]?.body.context).toEqual({ answers: [{ values: [], text: "Calm" }] });
  });

  it("keeps Send off for an answer of only spaces", async () => {
    render(<WidgetUiCard widgetId="m1" toolUseId="q4" appId="core" ui={ui} text="" waiting={{}} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Which tone?" }), {
      target: { value: "   " },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows nothing picked on a dismissed card, not its defaults", async () => {
    const withDefault = {
      ...(ui as { components: unknown[] }),
      data: { answers: [{ values: ["Warm"], text: "" }] },
    } as never;
    render(
      <WidgetUiCard
        widgetId="m1"
        toolUseId="q5"
        appId="core"
        ui={withDefault}
        text=""
        waiting={{ result: { dismissed: true } }}
      />,
    );
    await screen.findByText("Dismissed");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Warm" }).getAttribute("aria-pressed")).toBe(
        "false",
      ),
    );
  });

  it("reads a bound option description from the card's data", async () => {
    const bound = {
      components: [
        {
          id: "root",
          component: "ChoicePicker",
          options: [{ label: "Warm", value: "Warm", description: { path: "/hint" } }],
          value: { path: "/picked" },
        },
      ],
      data: { hint: "Friendly and short", picked: [] },
    } as never;
    render(<WidgetUiCard widgetId="m1" toolUseId="q6" appId="core" ui={bound} text="" />);
    expect(await screen.findByText("Friendly and short")).toBeTruthy();
  });

  it("falls back to the question card when the description cannot be drawn", async () => {
    const blocks = parseEntries(
      JSON.stringify([
        {
          type: "pending_interaction",
          toolUseId: "q7",
          appId: "core",
          render: {
            kind: "inline",
            componentId: "question-card",
            builtin: true,
            props: {
              questions: [
                { id: "tone", question: "Which tone?", type: "single", options: ["Warm"] },
              ],
            },
            ui: { components: [{ id: "root", component: "Modal" }] },
          },
        },
      ]),
    );
    render(<>{renderFlatEntries(blocks, { sessionId: "s1" })}</>);
    expect(await screen.findByText("Which tone?")).toBeTruthy();
    expect(screen.queryByText(/Could not show this card/)).toBeNull();
  });

  it("sends a button's context as written, even an object with only a string key", async () => {
    const events = captureEvents();
    const card = {
      components: [
        {
          id: "root",
          component: "Button",
          child: "l",
          action: { event: { name: "send", context: { tag: ["a", { string: "send" }] } } },
        },
        { id: "l", component: "Text", text: { string: "send" } },
      ],
    } as never;
    render(
      <WidgetUiCard widgetId="m1" toolUseId="q8" appId="core" ui={card} text="" waiting={{}} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));
    await waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]?.body.context).toEqual({ tag: ["a", { string: "send" }] });
  });
});

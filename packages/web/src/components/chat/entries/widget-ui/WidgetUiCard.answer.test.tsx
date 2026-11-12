// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import "@/i18n";
import { parseEntries } from "../parse-entries";
import { renderFlatEntries } from "../render";
import { WidgetUiCard } from "./WidgetUiCard";

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

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
      action: { event: { name: "rome:answer", context: { answers: { path: "/answers" } } } },
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
      action: { event: { name: "rome:dismiss" } },
    },
    { id: "actions", component: "Row", children: ["dismiss", "send"], justify: "end" },
    { id: "root", component: "Column", children: ["q0", "app-post", "actions"] },
  ],
  data: { answers: [{ values: [], text: "" }] },
} as never;

describe("a question card described as data", () => {
  it("answers the waiting turn with what the guardian picked, once a required question has an answer", async () => {
    const onSubmit = rs.fn();
    render(
      <WidgetUiCard
        toolUseId="q1"
        appId="core"
        ui={ui}
        text=""
        waiting={{ onSubmit, onDismiss: rs.fn() }}
      />,
    );

    const send = await screen.findByRole("button", { name: "Send" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Short sentences")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Plain/ }));
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toBe("q1");
    expect(onSubmit.mock.calls[0]?.[1]).toEqual({ answers: [{ values: ["Plain"], text: "" }] });
  });

  it("shows an answered card read-only with what was sent", async () => {
    const { container } = render(
      <WidgetUiCard
        toolUseId="q1"
        appId="core"
        ui={ui}
        text=""
        waiting={{
          result: {
            answers: [{ questionId: "tone", value: "Warm" }],
            card: [{ values: ["Warm"], text: "" }],
          },
          onSubmit: rs.fn(),
          onDismiss: rs.fn(),
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
    const onSubmit = rs.fn();
    render(
      <WidgetUiCard
        toolUseId="q2"
        appId="core"
        ui={ui}
        text=""
        waiting={{ onSubmit, onDismiss: rs.fn() }}
      />,
    );
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
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[1]).toEqual({ answers: [{ values: [], text: "Calm" }] });
  });

  it("keeps Send off for an answer of only spaces", async () => {
    render(
      <WidgetUiCard
        toolUseId="q4"
        appId="core"
        ui={ui}
        text=""
        waiting={{ onSubmit: rs.fn(), onDismiss: rs.fn() }}
      />,
    );
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
        toolUseId="q5"
        appId="core"
        ui={withDefault}
        text=""
        waiting={{ result: { dismissed: true }, onSubmit: rs.fn(), onDismiss: rs.fn() }}
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
    render(<WidgetUiCard toolUseId="q6" appId="core" ui={bound} text="" />);
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
    const onSubmit = rs.fn();
    const card = {
      components: [
        {
          id: "root",
          component: "Button",
          child: "l",
          action: { event: { name: "rome:answer", context: { tag: ["a", { string: "send" }] } } },
        },
        { id: "l", component: "Text", text: { string: "send" } },
      ],
    } as never;
    render(
      <WidgetUiCard
        toolUseId="q8"
        appId="core"
        ui={card}
        text=""
        waiting={{ onSubmit, onDismiss: rs.fn() }}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[1]).toEqual({ tag: ["a", { string: "send" }] });
  });
});

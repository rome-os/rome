// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import "@/i18n";
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
});

// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuestionCard } from "./QuestionCard";
import i18n from "@/i18n";

afterEach(async () => {
  cleanup();
  rs.restoreAllMocks();
  await i18n.changeLanguage("en");
});

const MULTI_PROPS = {
  questions: [
    {
      id: "interests",
      question: "Which areas?",
      type: "multi",
      options: ["AI", "Design", "Finance"],
      freeText: true,
    },
  ],
};

function optionButton(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function pressed(name: string): string | null {
  return optionButton(name).getAttribute("aria-pressed");
}

function renderCard(props: Record<string, unknown>, onSubmit = rs.fn()) {
  render(<QuestionCard toolUseId="t-1" props={props} onSubmit={onSubmit} onDismiss={() => {}} />);
  return onSubmit;
}

describe("QuestionCard — multi-choice", () => {
  it("keeps multiple options pressed at once and submits them joined", async () => {
    const user = userEvent.setup();
    const onSubmit = renderCard(MULTI_PROPS);

    await user.click(optionButton("AI"));
    await user.click(optionButton("Finance"));

    // Both stay selected — multi does not deselect the previous pick.
    expect(pressed("AI")).toBe("true");
    expect(pressed("Finance")).toBe("true");
    expect(pressed("Design")).toBe("false");

    await user.click(optionButton("Send"));

    expect(onSubmit).toHaveBeenCalledWith(
      "t-1",
      { answers: [{ questionId: "interests", value: "AI, Finance" }] },
      "AI, Finance",
    );
  });

  it("uses the active Rome language for the card controls", async () => {
    await i18n.changeLanguage("zh-CN");
    renderCard({
      questions: [
        {
          id: "interests",
          question: "你感兴趣什么？",
          type: "multi",
          options: ["人工智能"],
          freeText: true,
        },
        {
          id: "note",
          question: "其他信息",
          type: "text",
          optional: true,
        },
      ],
    });

    expect(screen.getByText("可选")).toBeTruthy();
    expect(screen.getByPlaceholderText("添加自己的选项…")).toBeTruthy();
    expect(screen.getByPlaceholderText("输入你的答案…")).toBeTruthy();
    expect(optionButton("发送")).toBeTruthy();
  });

  it("toggles an option off when tapped twice", async () => {
    const user = userEvent.setup();
    const onSubmit = renderCard(MULTI_PROPS);

    await user.click(optionButton("Design"));
    await user.click(optionButton("Design"));
    expect(pressed("Design")).toBe("false");

    // With nothing selected and no free-text, Send stays disabled (required).
    expect(optionButton("Send").disabled).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("appends typed free-text alongside the picked options", async () => {
    const user = userEvent.setup();
    const onSubmit = renderCard(MULTI_PROPS);

    await user.click(optionButton("AI"));
    await user.type(screen.getByPlaceholderText("Add your own…"), "Robotics");
    await user.click(optionButton("Send"));

    expect(onSubmit).toHaveBeenCalledWith(
      "t-1",
      { answers: [{ questionId: "interests", value: "AI, Robotics" }] },
      "AI, Robotics",
    );
  });

  it("rehydrates a resolved multi card from its stored answer", () => {
    render(
      <QuestionCard
        toolUseId="t-1"
        props={MULTI_PROPS}
        result={{ answers: [{ questionId: "interests", value: "AI, Design" }] }}
        onSubmit={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(pressed("AI")).toBe("true");
    expect(pressed("Design")).toBe("true");
    expect(pressed("Finance")).toBe("false");
    // Resolved cards lock — no Send button.
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });
});

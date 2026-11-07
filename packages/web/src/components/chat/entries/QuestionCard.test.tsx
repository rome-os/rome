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

describe("QuestionCard — long answers", () => {
  for (const type of ["single", "multi"]) {
    for (const option of [
      "按当前语言只显示对应的那一半（中文取「/」前，英文取后）",
      "W".repeat(33),
    ]) {
      it(`submits a complete ${type} answer with length ${option.length}`, async () => {
        const user = userEvent.setup();
        const onSubmit = renderCard({
          questions: [
            { id: "language", question: "Which label?", type, options: [option, "Short"] },
          ],
        });

        optionButton(option).focus();
        await user.keyboard(" ");
        expect(pressed(option)).toBe("true");
        await user.click(optionButton("Send"));

        expect(onSubmit).toHaveBeenCalledWith(
          "t-1",
          { answers: [{ questionId: "language", value: option }] },
          option,
        );
        expect(optionButton(option).closest("fieldset")?.disabled).toBe(true);
      });
    }
  }

  it("submits a custom single-choice answer instead of a selected long option", async () => {
    const user = userEvent.setup();
    const option = "按当前语言只显示对应的那一半（中文取「/」前，英文取后）";
    const onSubmit = renderCard({
      questions: [
        {
          id: "language",
          question: "Which label?",
          type: "single",
          options: [option],
          freeText: true,
        },
      ],
    });

    await user.click(optionButton(option));
    await user.type(screen.getByPlaceholderText("Or type your own…"), "Keep both languages");
    expect(pressed(option)).toBe("false");
    await user.click(optionButton("Send"));
    expect(onSubmit).toHaveBeenCalledWith(
      "t-1",
      { answers: [{ questionId: "language", value: "Keep both languages" }] },
      "Keep both languages",
    );
  });
});

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

const DEFAULT_PROPS = {
  questions: [
    {
      id: "kinds",
      question: "Which events?",
      type: "multi",
      options: ["Reviews", "Issues"],
      defaults: ["Reviews"],
      optionDescriptions: { Reviews: "Requests for review.", Issues: "New repository issues." },
    },
    {
      id: "scope",
      question: "Which scope?",
      type: "single",
      options: ["Mine", "All"],
      defaults: ["Mine"],
      optionDescriptions: { Mine: "Only events about me.", All: "Events across the repository." },
    },
    { id: "preference", question: "Anything else?", type: "text", defaultText: "Billing only" },
  ],
};

describe("QuestionCard — defaults and descriptions", () => {
  it("pads the described option button, not its content, and leaves plain options unchanged", () => {
    renderCard({
      questions: [
        {
          id: "q",
          question: "Which events?",
          type: "single",
          options: ["Reviews", "Issues"],
          optionDescriptions: { Reviews: "Requests for review." },
        },
      ],
    });
    const described = optionButton("Reviews Requests for review.");
    expect(described.className.split(" ")).toContain("py-2");
    expect(described.firstElementChild?.className.split(" ")).not.toContain("py-2");
    expect(optionButton("Issues").className.split(" ")).not.toContain("py-2");
  });

  it("ignores inherited keys when an option is labeled like an Object.prototype property", () => {
    renderCard({
      questions: [
        {
          id: "q",
          question: "Which events?",
          type: "single",
          options: ["__proto__", "constructor", "Other"],
          optionDescriptions: { Other: "Anything else." },
        },
      ],
    });
    expect(optionButton("__proto__").textContent).toBe("__proto__");
    expect(optionButton("constructor").textContent).toBe("constructor");
    expect(optionButton("constructor").className.split(" ")).not.toContain("py-2");
    expect(optionButton("Other Anything else.").className.split(" ")).toContain("py-2");
  });

  it("counts preselected required questions as answered and submits labels, not descriptions", async () => {
    const user = userEvent.setup();
    const onSubmit = renderCard(DEFAULT_PROPS);
    expect(pressed("Reviews Requests for review.")).toBe("true");
    expect(pressed("Issues New repository issues.")).toBe("false");
    expect(pressed("Mine Only events about me.")).toBe("true");
    expect(screen.getByText("Requests for review.").className).toContain(
      "text-primary-foreground/80",
    );
    expect(screen.getByText("New repository issues.").className).toContain("text-muted-foreground");
    expect(screen.getByDisplayValue("Billing only")).toBeTruthy();
    expect(optionButton("Send").disabled).toBe(false);
    await user.click(optionButton("Send"));
    expect(onSubmit).toHaveBeenCalledWith(
      "t-1",
      {
        answers: [
          { questionId: "kinds", value: "Reviews" },
          { questionId: "scope", value: "Mine" },
          { questionId: "preference", value: "Billing only" },
        ],
      },
      "Reviews · Mine · Billing only",
    );
  });

  it("lets the guardian change every default before sending", async () => {
    const user = userEvent.setup();
    const onSubmit = renderCard(DEFAULT_PROPS);
    await user.click(optionButton("Reviews Requests for review."));
    expect(optionButton("Send").disabled).toBe(true);
    await user.click(optionButton("Issues New repository issues."));
    await user.click(optionButton("All Events across the repository."));
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "Security only");
    await user.click(optionButton("Send"));
    expect(onSubmit).toHaveBeenCalledWith(
      "t-1",
      {
        answers: [
          { questionId: "kinds", value: "Issues" },
          { questionId: "scope", value: "All" },
          { questionId: "preference", value: "Security only" },
        ],
      },
      "Issues · All · Security only",
    );
  });

  it("allows clearing an optional multi default", async () => {
    const user = userEvent.setup();
    const onSubmit = renderCard({ questions: [{ ...DEFAULT_PROPS.questions[0], optional: true }] });
    await user.click(optionButton("Reviews Requests for review."));
    expect(optionButton("Send").disabled).toBe(false);
    await user.click(optionButton("Send"));
    expect(onSubmit).toHaveBeenCalledWith("t-1", { answers: [] }, "");
  });

  it("uses submitted answers rather than defaults when resolved, including omitted answers", () => {
    render(
      <QuestionCard
        toolUseId="t-1"
        props={DEFAULT_PROPS}
        result={{ answers: [{ questionId: "scope", value: "All" }] }}
        onSubmit={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(pressed("Reviews Requests for review.")).toBe("false");
    expect(pressed("Mine Only events about me.")).toBe("false");
    expect(pressed("All Events across the repository.")).toBe("true");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps comma-containing labels intact when the answer is rehydrated", async () => {
    const user = userEvent.setup();
    const props = {
      questions: [
        {
          id: "q",
          question: "Which events?",
          type: "multi",
          options: ["Comments, mentions", "Issues"],
          defaults: ["Comments, mentions"],
          freeText: true,
        },
      ],
    };
    const onSubmit = renderCard(props);
    await user.click(optionButton("Issues"));
    await user.type(screen.getByRole("textbox"), "Other, too");
    await user.click(optionButton("Send"));
    const result = {
      answers: [
        {
          questionId: "q",
          value: "Comments, mentions, Issues, Other, too",
          values: ["Comments, mentions", "Issues", "Other, too"],
        },
      ],
    };
    expect(onSubmit).toHaveBeenCalledWith("t-1", result, "Comments, mentions, Issues, Other, too");
    cleanup();
    render(
      <QuestionCard
        toolUseId="t-1"
        props={props}
        result={result}
        onSubmit={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(pressed("Comments, mentions")).toBe("true");
    expect(pressed("Issues")).toBe("true");
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Other, too");
  });

  it("keeps a plain single/text card's initial state and answer shape unchanged", async () => {
    const user = userEvent.setup();
    const onSubmit = renderCard({
      questions: [
        { id: "choice", question: "Pick one", type: "single", options: ["A", "B"] },
        { id: "text", question: "Your note", type: "text" },
      ],
    });
    expect(pressed("A")).toBe("false");
    expect(pressed("B")).toBe("false");
    expect(optionButton("Send").disabled).toBe(true);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    await user.click(optionButton("B"));
    await user.type(screen.getByRole("textbox"), "A note");
    await user.click(optionButton("Send"));
    expect(onSubmit).toHaveBeenCalledWith(
      "t-1",
      {
        answers: [
          { questionId: "choice", value: "B" },
          { questionId: "text", value: "A note" },
        ],
      },
      "B · A note",
    );
  });
});

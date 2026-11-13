// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/i18n";
import { questionCardRender } from "../../../../mock/fixtures/question-card";
import { QuestionCard } from "./QuestionCard";

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

const card = questionCardRender([
  {
    id: "interests",
    question: "Which areas?",
    type: "multi",
    options: ["AI", "Design", "Finance"],
    freeText: true,
  },
]);

const settled = (result: Record<string, unknown>) =>
  render(
    <QuestionCard
      toolUseId="t-1"
      appId="core"
      ui={card.ui}
      props={card.props}
      result={result}
      onSubmit={() => {}}
      onDismiss={() => {}}
    />,
  );

describe("QuestionCard — settled", () => {
  it("folds an answered card to its question and the answer, opening to the whole card", async () => {
    settled({ answers: [{ questionId: "interests", value: "AI, Design" }] });
    const fold = screen.getByRole("button", { name: "Which areas?Answered: AI, Design" });
    expect(screen.queryByRole("button", { name: "AI" })).toBeNull();
    await userEvent.click(fold);
    expect(await screen.findByRole("button", { name: "AI" })).toBeTruthy();
  });

  it("folds a dismissed card to say so", () => {
    settled({ dismissed: true });
    expect(screen.getByRole("button", { name: "Which areas?Dismissed" })).toBeTruthy();
  });
});

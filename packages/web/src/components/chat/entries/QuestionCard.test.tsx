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
      widgetId="m-1"
      onAnswer={() => {}}
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

describe("QuestionCard — just answered", () => {
  it("shows what was sent when the folded card opens, before core has stored it", async () => {
    render(
      <QuestionCard
        toolUseId="t-1"
        appId="core"
        ui={card.ui}
        props={card.props}
        result={{ answers: [{ values: ["Design"], text: "" }] }}
        widgetId="m-1"
        onAnswer={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Which areas\?/ }));
    const design = await screen.findByRole("button", { name: "Design" });
    expect(design.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "AI" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("unlocks again when the dismissal fails to send", async () => {
    render(
      <QuestionCard
        toolUseId="t-1"
        appId="core"
        ui={card.ui}
        props={card.props}
        widgetId="m-1"
        onAnswer={() => Promise.reject(new Error("offline"))}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(await screen.findByRole("button", { name: "Dismiss" })).toBeTruthy();
  });
});

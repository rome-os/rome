import { describe, it, expect } from "@rstest/core";
import { buildFacadeBundle } from "./mcp-facade.js";

const multi = (options: unknown) => ({
  questions: [{ id: "q1", question: "Pick any", type: "multi", options }],
});

const bundleParams = {
  getActionCatalog: () => [],
  getSkillCatalog: () => [],
  subagentTools: [],
  executeAction: async () => ({}),
  executeSubagent: async () => ({}),
};

function askQuestionHandler(supportsInteractiveSurface: boolean) {
  const bundle = buildFacadeBundle({ ...bundleParams, supportsInteractiveSurface });
  const tool = bundle.interactiveTools.find((t) => t.name === "ask_question");
  if (!tool) throw new Error("ask_question not registered");
  return tool.handler;
}

const QUESTIONS = {
  questions: [
    { id: "weekend", question: "Which weekend?", type: "single", options: ["This", "Next"] },
    { id: "city", question: "Which city?", type: "text" },
  ],
};

async function handlerText(supportsInteractiveSurface: boolean): Promise<string> {
  const res = (await askQuestionHandler(supportsInteractiveSurface)(QUESTIONS)) as {
    content: { type: string; text: string }[];
  };
  return res.content[0].text;
}

describe("ask_question handler — cross-surface behavior", () => {
  it("relays the questions as prose on a non-interactive surface", async () => {
    const text = await handlerText(false);
    expect(text).not.toContain("pendingInteraction");
    expect(text).toContain("Which weekend?");
    expect(text).toContain("- This");
    expect(text).toContain("- Next");
    expect(text).toContain("Which city?");
  });

  it("returns the built-in question-card payload on an interactive surface", async () => {
    const payload = JSON.parse(await handlerText(true)) as {
      pendingInteraction: boolean;
      render: { builtin: boolean; componentId: string };
    };
    expect(payload.pendingInteraction).toBe(true);
    expect(payload.render.builtin).toBe(true);
    expect(payload.render.componentId).toBe("question-card");
  });

  // Exact-mode forks advertise the interactive surface (prefix identity with
  // the source) but nothing drains their stream to mount the card — the
  // handler must take the prose path, not park the fork on a card that will
  // never render.
  it("relays the questions as prose when the interactive surface is detached", async () => {
    const bundle = buildFacadeBundle({
      ...bundleParams,
      supportsInteractiveSurface: true,
      interactiveSurfaceDetached: true,
    });
    const tool = bundle.interactiveTools.find((t) => t.name === "ask_question")!;
    const res = (await tool.handler(QUESTIONS)) as { content: { text: string }[] };
    const text = res.content[0].text;
    expect(text).not.toContain("pendingInteraction");
    expect(text).toContain("Which weekend?");
    expect(text).toContain("Which city?");
  });

  it("hints the free-text escape on a freeText single-choice in the prose fallback", async () => {
    const input = {
      questions: [
        { id: "q1", question: "Pick one", type: "single", options: ["A"], freeText: true },
      ],
    };
    const res = (await askQuestionHandler(false)(input)) as {
      content: { type: string; text: string }[];
    };
    const text = res.content[0].text;
    expect(text).toContain("- A");
    expect(text).toContain("(or describe your own)");
  });

  it("passes freeText through to the question-card payload", async () => {
    const input = {
      questions: [
        { id: "q1", question: "Pick one", type: "single", options: ["A"], freeText: true },
      ],
    };
    const res = (await askQuestionHandler(true)(input)) as {
      content: { type: string; text: string }[];
    };
    const payload = JSON.parse(res.content[0].text) as {
      render: { props: { questions: { freeText?: boolean }[] } };
    };
    expect(payload.render.props.questions[0].freeText).toBe(true);
  });

  it("renders multi-choice options with a pick-any hint in the prose fallback", async () => {
    const input = {
      questions: [
        {
          id: "q1",
          question: "Which areas?",
          type: "multi",
          options: ["AI", "Design"],
          freeText: true,
        },
      ],
    };
    const res = (await askQuestionHandler(false)(input)) as {
      content: { type: string; text: string }[];
    };
    const text = res.content[0].text;
    expect(text).toContain("Which areas? (pick any that apply)");
    expect(text).toContain("- AI");
    expect(text).toContain("- Design");
    expect(text).toContain("(or describe your own)");
  });

  it("passes the multi type through to the question-card payload", async () => {
    const res = (await askQuestionHandler(true)(multi(["A", "B"]))) as {
      content: { type: string; text: string }[];
    };
    const payload = JSON.parse(res.content[0].text) as {
      render: { props: { questions: { type?: string }[] } };
    };
    expect(payload.render.props.questions[0].type).toBe("multi");
  });

  it("marks optional questions and passes the flag through", async () => {
    const input = {
      questions: [{ id: "q1", question: "Anything else?", type: "text", optional: true }],
    };
    const prose = (await askQuestionHandler(false)(input)) as {
      content: { type: string; text: string }[];
    };
    expect(prose.content[0].text).toContain("Anything else? (optional)");

    const card = (await askQuestionHandler(true)(input)) as {
      content: { type: string; text: string }[];
    };
    const payload = JSON.parse(card.content[0].text) as {
      render: { props: { questions: { optional?: boolean }[] } };
    };
    expect(payload.render.props.questions[0].optional).toBe(true);
  });
});

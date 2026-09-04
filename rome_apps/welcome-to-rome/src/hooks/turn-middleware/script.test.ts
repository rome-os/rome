import { describe, expect, it, rs } from "@rstest/core";
import { runTurn, type WelcomeEffects } from "./script.js";
import type { ProgressRepository, WelcomeProgress } from "../../db/repositories/progress.js";

// Drive the state machine with an in-memory progress row and spies for the
// side-effect ports — no DB or AgentSession needed.
function makeEffects(node: WelcomeProgress["node"], overrides: Partial<WelcomeProgress> = {}) {
  let row: WelcomeProgress = {
    node,
    introRawInput: null,
    introSummary: null,
    ideas: [],
    ideasGeneratedAt: null,
    aiConnected: null,
    completedAt: null,
    ...overrides,
  };
  const progress = {
    get: () => row,
    patch: (p: Partial<WelcomeProgress> & { appIdeas?: string; appIdeasGeneratedAt?: string }) => {
      row = {
        ...row,
        ...p,
        ideas:
          typeof p.appIdeas === "string"
            ? (JSON.parse(p.appIdeas) as WelcomeProgress["ideas"])
            : row.ideas,
        ideasGeneratedAt: p.appIdeasGeneratedAt ?? row.ideasGeneratedAt,
      };
      return row;
    },
  } as unknown as ProgressRepository;
  const writeNames = rs.fn(async () => ({ ok: true }));
  const fx = {
    progress,
    getAgentName: rs.fn(async () => "Rome"),
    getGuardianName: rs.fn(async () => "Alex"),
    getLocale: rs.fn(async () => "en" as const),
    writeNames,
    say: rs.fn(async () => {}),
    summon: rs.fn(),
  } as unknown as WelcomeEffects;
  return { fx, writeNames, getRow: () => row, getNode: () => row.node };
}

/** Wrap an object as the fenced JSON resolution prompt core feeds back. */
const resolution = (obj: unknown) => `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
const DISMISSED = "The guardian dismissed the interaction without producing a result.";

describe("runTurn — greeting and the name card", () => {
  it("greets by name and prefills the card with both names", async () => {
    const { fx, getNode } = makeEffects("greet");
    rs.mocked(fx.getAgentName).mockResolvedValue("Nova");

    const reply = await runTurn("Let's get started", fx);

    expect(reply).toMatchObject({
      componentId: "name-card",
      lead: expect.stringContaining("Hi Alex — I'm Nova."),
      props: { guardianName: "Alex", agentName: "Nova" },
    });
    expect(getNode()).toBe("await_names");
  });

  it("asks for the name instead of guessing when setup stored none", async () => {
    const { fx } = makeEffects("greet");
    rs.mocked(fx.getGuardianName).mockResolvedValue(null);

    const reply = await runTurn("Let's get started", fx);

    expect(reply).toMatchObject({
      componentId: "name-card",
      lead: expect.stringContaining("what should I call you?"),
      props: { guardianName: "", agentName: "Rome" },
    });
    // No blank interpolated into the greeting.
    expect(reply.kind === "component" && reply.lead).not.toContain("Hi  ");
  });

  it("uses Chinese copy from the first welcome step", async () => {
    const { fx } = makeEffects("greet");
    rs.mocked(fx.getLocale).mockResolvedValue("zh-CN");

    const reply = await runTurn("开始设置", fx);

    expect(reply).toMatchObject({
      componentId: "name-card",
      lead: expect.stringContaining("👋 你好 Alex，我是 Rome。"),
    });
  });

  it("leaves the greeting with both names written, then asks to connect an AI", async () => {
    const { fx, writeNames, getNode } = makeEffects("await_names");

    const reply = await runTurn(resolution({ guardianName: "Alexandra", agentName: "Nova" }), fx);

    expect(writeNames).toHaveBeenCalledOnce();
    expect(writeNames).toHaveBeenCalledWith({ guardianName: "Alexandra", agentName: "Nova" });
    expect(reply).toMatchObject({ kind: "connect_ai", lead: expect.stringContaining("Claude") });
    expect(getNode()).toBe("await_ai");
  });

  it("keeps the prefilled names on a dismissed card", async () => {
    const { fx, writeNames, getNode } = makeEffects("await_names");

    await runTurn(DISMISSED, fx);

    expect(writeNames).toHaveBeenCalledWith({ guardianName: "Alex", agentName: "Rome" });
    expect(getNode()).toBe("await_ai");
  });

  it("re-shows the card on typed text and stays parked", async () => {
    const { fx, writeNames, getNode } = makeEffects("await_names");

    const reply = await runTurn("what is this?", fx);

    expect(writeNames).not.toHaveBeenCalled();
    expect(reply).toMatchObject({ componentId: "name-card" });
    expect(getNode()).toBe("await_names");
  });
});

describe("runTurn — connect an AI", () => {
  it("resolves when the status probe reports a provider logged in", async () => {
    const { fx, getRow } = makeEffects("await_ai");

    const reply = await runTurn(resolution({ connected: true }), fx);

    expect(reply).toMatchObject({ kind: "ask" });
    if (reply.kind === "ask") {
      expect(reply.questions).toHaveLength(1);
      expect(reply.questions[0]).toMatchObject({ id: "weekLooksLike" });
    }
    expect(getRow().node).toBe("await_question");
    expect(getRow().aiConnected).toBe(true);
  });

  it("returns to the connect step after a page exit (typed text re-shows the card)", async () => {
    const { fx, getNode } = makeEffects("await_ai");

    const reply = await runTurn("I'm back", fx);

    expect(reply).toMatchObject({ kind: "connect_ai" });
    expect(getNode()).toBe("await_ai");
  });

  it("moves on without a provider on skip", async () => {
    const { fx, getRow } = makeEffects("await_ai");

    const reply = await runTurn(resolution({ skip: true }), fx);

    expect(reply).toMatchObject({ kind: "ask" });
    expect(getRow().node).toBe("await_question");
    expect(getRow().aiConnected).toBe(false);
  });
});

describe("runTurn — the one question", () => {
  it("skips the fold and reaches the static idea list without summoning when AI was skipped", async () => {
    const { fx, getRow } = makeEffects("await_question", { aiConnected: false });

    const reply = await runTurn(
      resolution({
        answers: [{ questionId: "weekLooksLike", value: "Twelve tabs open, none of them read" }],
      }),
      fx,
    );

    expect(fx.summon).not.toHaveBeenCalled();
    expect(reply).toMatchObject({ componentId: "idea-picker" });
    expect(reply.kind === "component" && reply.props.ideas).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Mood diary" })]),
    );
    // The raw answer stays for a later fold.
    expect(getRow().introRawInput).toBe(
      "Where their week gets stuck: Twelve tabs open, none of them read",
    );
    expect(getRow().node).toBe("await_idea");
  });

  it("folds the answer into memory via an inline welcome-memory summon when AI is connected", async () => {
    const { fx, getNode } = makeEffects("await_question", { aiConnected: true });
    rs.mocked(fx.summon).mockImplementation(async (agent: string) =>
      agent === "welcome-memory"
        ? { ok: true, output: { summary: "Wants help with research." } }
        : { ok: true, output: { ideas: [{ title: "Paper radar", prompt: "Build it." }] } },
    );

    const reply = await runTurn(
      resolution({
        answers: [{ questionId: "weekLooksLike", value: "Twelve tabs open, none of them read" }],
      }),
      fx,
    );

    expect(fx.summon).toHaveBeenCalledWith(
      "welcome-memory",
      expect.stringContaining("Twelve tabs open, none of them read"),
    );
    // A research basis offers scouts before the brainstorm.
    expect(reply).toMatchObject({ componentId: "scout-suggestions" });
    expect(getNode()).toBe("await_scouts");
  });

  it("uses the Chinese question when the guardian selected Chinese", async () => {
    const { fx } = makeEffects("await_ai");
    rs.mocked(fx.getLocale).mockResolvedValue("zh-CN");

    const reply = await runTurn(resolution({ connected: true }), fx);

    expect(reply.kind).toBe("ask");
    if (reply.kind === "ask") {
      expect(reply.lead).toBe("只问一个问题，然后我们就开始做点东西：");
      expect(reply.questions[0]).toMatchObject({ question: "下面哪个最像你的一周？" });
    }
  });

  it("re-shows the card and stays parked on typed text (no card submission)", async () => {
    const { fx, getNode } = makeEffects("await_question", { aiConnected: true });

    const reply = await runTurn("actually, I'm a designer", fx);

    expect(fx.summon).not.toHaveBeenCalled();
    expect(reply).toMatchObject({ kind: "ask" });
    expect(getNode()).toBe("await_question");
  });
});

describe("runTurn — scouts and the brainstorm", () => {
  it("continues to the first-app idea picker after the scout card resolves", async () => {
    const { fx, getNode } = makeEffects("await_scouts", {
      aiConnected: true,
      introSummary: "Interests: design and product strategy.",
    });
    rs.mocked(fx.summon).mockResolvedValue({
      ok: true,
      output: { ideas: [{ title: "Launch tracker", prompt: "Build me a launch tracker." }] },
    });

    const reply = await runTurn(resolution({ addedTitles: ["Product launch watch"] }), fx);

    expect(fx.summon).toHaveBeenCalledOnce();
    expect(reply).toMatchObject({ componentId: "idea-picker" });
    expect(getNode()).toBe("await_idea");
  });
});

describe("runTurn — done", () => {
  it("ends with the chosen kickoff prompt's idea named, for the fresh chat the picker opened", async () => {
    const { fx, getRow } = makeEffects("await_idea", {
      ideas: [{ title: "Launch tracker", prompt: "Build me a launch tracker." }],
    });

    const reply = await runTurn(resolution({ ideaTitle: "Launch tracker" }), fx);

    expect(reply).toMatchObject({
      kind: "text",
      text: expect.stringContaining('Let\'s build "Launch tracker"'),
    });
    expect(getRow().node).toBe("done");
    expect(getRow().completedAt).toEqual(expect.any(String));
  });

  it("uses the Chinese fallback title without changing the English one", async () => {
    const { fx } = makeEffects("await_idea");
    rs.mocked(fx.getLocale).mockResolvedValue("zh-CN");

    const reply = await runTurn(resolution({ ideaTitle: "培养习惯" }), fx);
    expect(reply).toMatchObject({ kind: "text", text: expect.stringContaining("「培养习惯」") });

    const { fx: englishFx } = makeEffects("await_idea");
    const englishReply = await runTurn(resolution({ ideaTitle: "Habit garden" }), englishFx);
    expect(englishReply).toMatchObject({
      kind: "text",
      text: expect.stringContaining('Let\'s build "Habit garden"'),
    });
  });

  it("closes without a pick on the explore opt-out", async () => {
    const { fx, getNode } = makeEffects("await_idea");

    const reply = await runTurn(resolution({ ideaTitle: "__explore__" }), fx);

    expect(reply).toMatchObject({ kind: "text", text: expect.stringContaining("all set") });
    expect(getNode()).toBe("done");
  });

  it("restarts from the name card on a typed start over", async () => {
    const { fx, getRow } = makeEffects("done", { aiConnected: true, completedAt: "2026-01-01" });

    const reply = await runTurn("start over", fx);

    expect(reply).toMatchObject({ componentId: "name-card" });
    expect(getRow().node).toBe("await_names");
    expect(getRow().aiConnected).toBeNull();
  });
});

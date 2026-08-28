import { describe, expect, it, rs } from "@rstest/core";
import { runTurn, type WelcomeEffects } from "./script.js";
import type { ProgressRepository, WelcomeProgress } from "../../db/repositories/progress.js";

// Drive the state machine with an in-memory progress row and spies for the
// side-effect ports — no DB, browser, or AgentSession needed.
function makeEffects(node: WelcomeProgress["node"], overrides: Partial<WelcomeProgress> = {}) {
  let row: WelcomeProgress = {
    node,
    introRawInput: null,
    introSummary: null,
    ideas: [],
    ideasGeneratedAt: null,
    completedAt: null,
    ...overrides,
  };
  const send = rs.fn(async () => ({ ok: true }));
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
  const fx = {
    progress,
    getAgentName: rs.fn(async () => "Rome"),
    getLocale: rs.fn(async () => "en" as const),
    say: rs.fn(async () => {}),
    summon: rs.fn(),
    chatgpt: {} as WelcomeEffects["chatgpt"],
    email: { send },
  } as unknown as WelcomeEffects;
  return { fx, send, getNode: () => row.node };
}

/** Wrap an object as the fenced JSON resolution prompt core feeds back. */
const resolution = (obj: unknown) => `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;

describe("runTurn — email handshake gate", () => {
  it("greets with the guardian-chosen agent name", async () => {
    const { fx } = makeEffects("greet");
    rs.mocked(fx.getAgentName).mockResolvedValue("Nova");

    const reply = await runTurn("Let's get started", fx);

    expect(reply).toMatchObject({
      componentId: "email-handshake",
      lead: expect.stringContaining("I'm Nova."),
    });
  });

  it("uses Chinese copy from the first welcome step", async () => {
    const { fx } = makeEffects("greet");
    rs.mocked(fx.getLocale).mockResolvedValue("zh-CN");

    const reply = await runTurn("开始设置", fx);

    expect(reply).toMatchObject({
      componentId: "email-handshake",
      lead: expect.stringContaining("👋 你好，我是 Rome。"),
    });
  });

  it("sends the hello only on an explicit { agreed: true }", async () => {
    const { fx, send, getNode } = makeEffects("await_email");
    const reply = await runTurn(resolution({ agreed: true, guardianEmail: "g@x.com" }), fx);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("g@x.com", expect.any(String), expect.any(String));
    expect(reply).toMatchObject({ componentId: "email-receipt" });
    expect(getNode()).toBe("await_email_receipt");
  });

  it("uses the guardian-chosen agent name in the hello email body", async () => {
    const { fx, send } = makeEffects("await_email");
    rs.mocked(fx.getAgentName).mockResolvedValue("Nova");

    await runTurn(resolution({ agreed: true, guardianEmail: "g@x.com" }), fx);

    expect(send).toHaveBeenCalledWith(
      "g@x.com",
      "Hello from Rome 👋",
      expect.stringContaining("I'm **Nova**"),
    );
    expect(send).toHaveBeenCalledWith(
      "g@x.com",
      "Hello from Rome 👋",
      expect.stringContaining("**Nova**"),
    );
  });

  it("does NOT send mail on free text — re-shows the handshake", async () => {
    const { fx, send, getNode } = makeEffects("await_email");
    const reply = await runTurn("why do I need this?", fx);
    expect(send).not.toHaveBeenCalled();
    expect(reply).toMatchObject({ componentId: "email-handshake" });
    // Still waiting on a real choice — no forward progress.
    expect(getNode()).toBe("await_email");
  });

  it("does NOT send mail on a malformed resolution without agreed", async () => {
    const { fx, send } = makeEffects("await_email");
    const reply = await runTurn(resolution({ guardianEmail: "g@x.com" }), fx);
    expect(send).not.toHaveBeenCalled();
    expect(reply).toMatchObject({ componentId: "email-handshake" });
  });

  it("skips to getting-to-know-you on { skip: true } without sending", async () => {
    const { fx, send, getNode } = makeEffects("await_email");
    const reply = await runTurn(resolution({ skip: true }), fx);
    expect(send).not.toHaveBeenCalled();
    expect(reply).toMatchObject({ componentId: "intro-choice" });
    expect(getNode()).toBe("await_choice");
  });
});

describe("runTurn — getting-to-know-you questionnaire", () => {
  it("shows the built-in ask_question card when the guardian picks 'answer'", async () => {
    const { fx, getNode } = makeEffects("await_choice");
    const reply = await runTurn(resolution({ choice: "answer" }), fx);
    expect(reply).toMatchObject({ kind: "ask" });
    expect(getNode()).toBe("await_questions");
  });

  it("uses Chinese questions when the guardian selected Chinese", async () => {
    const { fx, getNode } = makeEffects("await_choice");
    rs.mocked(fx.getLocale).mockResolvedValue("zh-CN");

    const reply = await runTurn(resolution({ choice: "回答几个问题" }), fx);

    expect(reply.kind).toBe("ask");
    if (reply.kind === "ask") {
      expect(reply.lead).toBe("很好，回答几个小问题吧。点击或输入都可以：");
      expect(reply.questions[0]).toMatchObject({ question: "你的角色或所在领域是什么？" });
    }
    expect(getNode()).toBe("await_questions");
  });

  it("accepts the Chinese browser-skip action", async () => {
    const { fx, getNode } = makeEffects("await_browser");
    rs.mocked(fx.getLocale).mockResolvedValue("zh-CN");

    const reply = await runTurn(resolution({ action: "暂时跳过" }), fx);

    expect(reply).toMatchObject({ kind: "ask" });
    expect(getNode()).toBe("await_questions");
  });

  it("folds the answers into memory via an inline welcome-memory summon", async () => {
    const { fx, getNode } = makeEffects("await_questions");
    // Route the memory summon vs. the later ideas summon by agent name.
    rs.mocked(fx.summon).mockImplementation(async (agent: string) =>
      agent === "welcome-memory"
        ? { ok: true, output: { summary: "Engineer interested in AI." } }
        : { ok: true, output: { ideas: [{ title: "Launch tracker", prompt: "Build it." }] } },
    );

    const reply = await runTurn(
      resolution({
        answers: [
          { questionId: "role", value: "Engineering" },
          { questionId: "interests", value: "AI & machine learning" },
        ],
      }),
      fx,
    );

    // welcome-memory got the formatted answers as its source text.
    expect(fx.summon).toHaveBeenCalledWith(
      "welcome-memory",
      expect.stringContaining("Engineering"),
    );
    // It then continues to scouts (AI/eng basis) without a separate turn.
    expect(reply).toMatchObject({ componentId: "scout-suggestions" });
    expect(getNode()).toBe("await_scouts");
  });

  it("re-shows the card and stays parked on typed text (no card submission)", async () => {
    const { fx, getNode } = makeEffects("await_questions");
    const reply = await runTurn("actually, I'm a designer", fx);
    // Typed input is not a completed questionnaire: don't fold, don't advance.
    expect(fx.summon).not.toHaveBeenCalled();
    expect(reply).toMatchObject({ kind: "ask" });
    expect(getNode()).toBe("await_questions");
  });
});

describe("runTurn — locale fallback ideas", () => {
  it("uses the Chinese fallback title without changing the English one", async () => {
    const { fx } = makeEffects("await_idea");
    rs.mocked(fx.getLocale).mockResolvedValue("zh-CN");

    const reply = await runTurn(resolution({ ideaTitle: "培养习惯" }), fx);

    expect(reply).toMatchObject({
      componentId: "completion-card",
      props: { heading: "我们来做「培养习惯」。" },
    });

    const { fx: englishFx } = makeEffects("await_idea");
    const englishReply = await runTurn(resolution({ ideaTitle: "Habit garden" }), englishFx);
    expect(englishReply).toMatchObject({
      componentId: "completion-card",
      props: { heading: 'Let\'s build "Habit garden".' },
    });
  });
});

describe("runTurn — briefing scout suggestions", () => {
  it("offers briefing scouts after the ChatGPT import is folded, before app ideas", async () => {
    const { fx, getNode } = makeEffects("await_browser", {
      introRawInput: "The guardian cares about AI, software engineering, and product strategy.",
    });
    fx.chatgpt.checkLogin = rs.fn(async () => ({ loggedIn: true, reason: "" }));
    fx.chatgpt.scrape = rs.fn(async () => ({
      ok: true,
      reply: "The guardian cares about AI, software engineering, and product strategy.",
    }));
    rs.mocked(fx.summon).mockResolvedValue({
      ok: true,
      output: { summary: "Interests: AI and software engineering." },
    });

    const reply = await runTurn(resolution({ action: "continue" }), fx);

    expect(fx.summon).toHaveBeenCalledWith("welcome-memory", expect.any(String));
    expect(reply).toMatchObject({ componentId: "scout-suggestions" });
    expect(reply.props.scouts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "AI launches radar" }),
        expect.objectContaining({ title: "Developer tooling watch" }),
      ]),
    );
    expect(getNode()).toBe("await_scouts");
  });

  it("continues to the first-app idea picker after the scout card resolves", async () => {
    const { fx, getNode } = makeEffects("await_scouts", {
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

  it("localizes Chinese scout suggestions from Chinese answers", async () => {
    const { fx } = makeEffects("await_questions");
    rs.mocked(fx.getLocale).mockResolvedValue("zh-CN");
    rs.mocked(fx.summon).mockResolvedValue({
      ok: true,
      output: { summary: "对人工智能和软件工程感兴趣。" },
    });

    const reply = await runTurn(
      resolution({
        answers: [{ questionId: "interests", value: "人工智能, 软件与工程" }],
      }),
      fx,
    );

    expect(reply).toMatchObject({
      componentId: "scout-suggestions",
      lead: "我还可以为你的 Briefing 添加几个观察任务，让 Rome 持续留意对你有用的信息。",
      props: {
        scouts: expect.arrayContaining([
          expect.objectContaining({ title: "AI 发布雷达" }),
          expect.objectContaining({ title: "开发者工具观察" }),
        ]),
      },
    });
    expect(fx.summon).toHaveBeenCalledWith(
      "welcome-memory",
      expect.stringContaining("Write every guardian-facing field in Simplified Chinese."),
    );
  });
});

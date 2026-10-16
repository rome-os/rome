import { describe, expect, it, rs } from "@rstest/core";
import {
  closingMessageAfterBuild,
  finishBuild,
  isOnboardingBuildTurn,
  runTurn,
  startBuild,
  webchatThreadId,
  type WelcomeEffects,
} from "./script.js";
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
    buildPrompt: null,
    buildSessionId: null,
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
    closingInFlight: rs.fn((): Promise<boolean> | null => null),
  } as unknown as WelcomeEffects;
  return { fx, writeNames, getRow: () => row, getNode: () => row.node };
}

/** Wrap an object as the fenced JSON resolution prompt core feeds back. */
const resolution = (obj: unknown) => `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
/** The same result with the preamble core puts before it. */
const resolved = (obj: unknown) =>
  `The interaction the guardian was working in resolved with this result:\n\n${resolution(obj)}\n\nContinue based on this result.`;
const DISMISSED = "The guardian dismissed the interaction without producing a result.";
/** The context blocks core can put ahead of a turn's prompt. */
const THREAD_CONTEXT = "<thread_context>\nChat: Welcome\n</thread_context>\n\n";
const WORKSPACE_CONTEXT =
  "<workspace_context>\nOpen: Notes &lt;draft&gt;\n</workspace_context>\n\n";

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

  it.each([
    ["", ""],
    [" behind the open surfaces' context", WORKSPACE_CONTEXT],
    [" behind a new session's framing", `${THREAD_CONTEXT}${WORKSPACE_CONTEXT}`],
  ])("keeps the prefilled names on a dismissed card%s", async (_label, prefix) => {
    const { fx, writeNames, getNode } = makeEffects("await_names");

    await runTurn(`${prefix}${DISMISSED}`, fx);

    expect(writeNames).toHaveBeenCalledWith({ guardianName: "Alex", agentName: "Rome" });
    expect(getNode()).toBe("await_ai");
  });

  it("stays parked when the host fails to store the names", async () => {
    const { fx, writeNames, getNode } = makeEffects("await_names");
    rs.mocked(writeNames).mockResolvedValue({ ok: false });

    const reply = await runTurn(resolution({ guardianName: "Alexandra", agentName: "Nova" }), fx);

    expect(reply).toMatchObject({ componentId: "name-card" });
    expect(getNode()).toBe("await_names");
  });

  // A seat repaired from a legacy instance has no stored name to fall back on.
  it("stays parked when the card comes back with a blank name and none is stored", async () => {
    const { fx, writeNames, getNode } = makeEffects("await_names");
    rs.mocked(fx.getGuardianName).mockResolvedValue(null);

    const reply = await runTurn(resolution({ guardianName: "  ", agentName: "Nova" }), fx);

    expect(writeNames).not.toHaveBeenCalled();
    expect(reply).toMatchObject({ componentId: "name-card" });
    expect(getNode()).toBe("await_names");
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
    // What Rome can do is said before the question, ending on a full stop.
    expect(fx.say).toHaveBeenCalledOnce();
    const said = rs.mocked(fx.say).mock.calls[0]?.[0] ?? "";
    expect(said).toMatch(/^Here's what I can do\..*\.$/);
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
    // With no AI to run the build, "Build this" opens a new chat with a draft.
    expect(reply).toMatchObject({ componentId: "idea-picker", props: { buildInChat: false } });
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
    // Straight from the answer to the brainstorm, with no briefing step between.
    expect(fx.summon).toHaveBeenCalledWith("welcome-app-ideas", expect.any(String));
    expect(fx.say).toHaveBeenCalledWith("Got it. Brainstorming a few first apps for you…");
    expect(reply).toMatchObject({ componentId: "idea-picker", props: { buildInChat: true } });
    expect(getNode()).toBe("await_idea");
  });

  it("uses the Chinese question when the guardian selected Chinese", async () => {
    const { fx } = makeEffects("await_ai");
    rs.mocked(fx.getLocale).mockResolvedValue("zh-CN");

    const reply = await runTurn(resolution({ connected: true }), fx);

    expect(reply.kind).toBe("ask");
    if (reply.kind === "ask") {
      expect(reply.lead).toBe("先跟我说说你自己，然后我们一起做点东西。");
      expect(reply.questions[0]).toMatchObject({ question: "下面哪个最像你的一周？" });
    }
  });

  it("re-shows the card and stays parked on typed text (no card submission)", async () => {
    const { fx, getNode } = makeEffects("await_question", { aiConnected: true });

    const reply = await runTurn("actually, I'm a designer", fx);

    expect(fx.summon).not.toHaveBeenCalled();
    expect(reply).toMatchObject({ kind: "ask" });
    expect(getNode()).toBe("await_question");
    // The capabilities line is said once, on the way in, not with each re-show.
    expect(fx.say).not.toHaveBeenCalled();
  });
});

describe("runTurn — a conversation parked on the removed scout step", () => {
  it("carries on to the first-app idea picker", async () => {
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

describe("withEndPunctuation", () => {
  it("adds a full stop only when a message stops short", async () => {
    const { withEndPunctuation } = await import("./copy.js");
    expect(withEndPunctuation("You work in design", "en")).toBe("You work in design.");
    expect(withEndPunctuation("You work in design!", "en")).toBe("You work in design!");
    expect(withEndPunctuation("你从事设计", "zh-CN")).toBe("你从事设计。");
    expect(withEndPunctuation("你从事设计。", "zh-CN")).toBe("你从事设计。");
  });
});

describe("runTurn — done", () => {
  it("hands the picked idea to the guardian's agent in this chat", async () => {
    const { fx, getRow } = makeEffects("await_idea", {
      aiConnected: true,
      ideas: [{ title: "Launch tracker", prompt: "Build me a launch tracker." }],
    });

    const reply = await runTurn(resolution({ ideaTitle: "Launch tracker" }), fx);

    expect(reply).toMatchObject({
      kind: "handoff",
      lead: 'Let\'s build "Launch tracker".',
      agentName: "core:main",
      agentLabel: "Rome",
    });
    // The brief is the idea's prompt, plus a request to ask through the question
    // card, so a question parks the build instead of ending it. The welcome
    // posts its own closing message after the build.
    if (reply.kind !== "handoff") return;
    expect(reply.brief).toBe(
      "Build me a launch tracker.\n\nIf you need to ask me anything, ask with the ask_question tool, not in plain text.",
    );
    // Not finished yet: the welcome closes after the build turn.
    expect(getRow().node).toBe("building");
    expect(getRow().buildPrompt).toBe(reply.brief);
    expect(getRow().completedAt).toBeNull();
  });

  it.each([
    ["shown without an AI", false, "Send it once an AI is connected."],
    // A card from before the build moved into this chat drafts even with an AI.
    ["from before the build moved into this chat", true, "Send it whenever you like."],
  ])("finishes the welcome when a card %s opened a drafted chat", async (_label, aiConnected, send) => {
    const { fx, getRow } = makeEffects("await_idea", {
      aiConnected,
      ideas: [{ title: "Launch tracker", prompt: "Build me a launch tracker." }],
    });

    const reply = await runTurn(resolution({ ideaTitle: "Launch tracker", openedDraft: true }), fx);

    expect(reply).toMatchObject({
      kind: "text",
      text: expect.stringContaining("I've opened a fresh chat with the kickoff prompt ready"),
    });
    if (reply.kind === "text") expect(reply.text).toContain(send);
    expect(getRow().node).toBe("done");
    expect(getRow().buildPrompt).toBeNull();
  });

  describe("with the open surfaces ahead of a typed reply", () => {
    const ideas = [
      { title: "Launch tracker", prompt: "Build me a launch tracker." },
      { title: "Habit garden", prompt: "Build me a habit garden." },
    ];
    // A focused file whose name holds a number, as webchat puts it ahead of the turn.
    const typed = (text: string) =>
      `<workspace_context>\nFocused file: chapter-1.md\n</workspace_context>\n\n${text}`;

    it("reads a typed number as the guardian's pick", async () => {
      const { fx } = makeEffects("await_idea", { aiConnected: true, ideas });

      const reply = await runTurn(typed("2"), fx);

      expect(reply).toMatchObject({ kind: "handoff", lead: 'Let\'s build "Habit garden".' });
    });

    it("reads a typed skip as passing on every idea", async () => {
      const { fx, getRow } = makeEffects("await_idea", { aiConnected: true, ideas });

      const reply = await runTurn(typed("skip"), fx);

      expect(reply).toMatchObject({ kind: "text", text: expect.stringContaining("all set") });
      expect(getRow().buildPrompt).toBeNull();
    });
  });

  it("reads progress after the locale, so a turn that waited on it sees the welcome end", async () => {
    const { fx, getRow } = makeEffects("building", { buildSessionId: "build-chat" });
    let loadLocale: (locale: "en") => void = () => {};
    rs.mocked(fx.getLocale).mockImplementation(
      () => new Promise((resolve) => (loadLocale = resolve)),
    );

    const turn = runTurn(DISMISSED, fx);
    // The closing message posts and ends the welcome while the locale loads.
    fx.progress.patch({ node: "done", completedAt: "2026-10-16T00:00:00Z" });
    loadLocale("en");

    expect(await turn).toEqual({ kind: "none" });
    expect(getRow().node).toBe("done");
  });

  it("shows the picker again for a typed pick with no AI connected, since no chat opened", async () => {
    const ideas = [{ title: "Launch tracker", prompt: "Build me a launch tracker." }];
    const { fx, getRow } = makeEffects("await_idea", { aiConnected: false, ideas });

    const reply = await runTurn("1", fx);

    expect(reply).toEqual({
      kind: "component",
      componentId: "idea-picker",
      props: { ideas, buildInChat: false },
    });
    expect(getRow().node).toBe("await_idea");
  });

  it("finishes the welcome when the build handoff closes before the build turn ends", async () => {
    const { fx, getRow } = makeEffects("building");

    const reply = await runTurn(DISMISSED, fx);

    expect(reply).toMatchObject({ kind: "text", text: expect.stringContaining("all set") });
    if (reply.kind === "text") expect(reply.text).toContain("App Store");
    expect(getRow().node).toBe("done");
    expect(getRow().completedAt).toEqual(expect.any(String));
  });

  it("adds nothing when the build handoff closes while the closing message posts", async () => {
    const { fx, getRow } = makeEffects("building", { buildSessionId: "build-chat" });
    rs.mocked(fx.closingInFlight).mockImplementation((threadId) =>
      threadId === "build-chat" ? Promise.resolve(true) : null,
    );

    expect(await runTurn(DISMISSED, fx)).toEqual({ kind: "none" });
    // The posted closing message ended the welcome itself.
    expect(getRow().node).toBe("building");
  });

  it("finishes the welcome itself when the closing message it waited on fails to post", async () => {
    const { fx, getRow } = makeEffects("building", { buildSessionId: "build-chat" });
    rs.mocked(fx.closingInFlight).mockImplementation(() => Promise.resolve(false));

    const reply = await runTurn(DISMISSED, fx);

    expect(reply).toMatchObject({ kind: "text", text: expect.stringContaining("all set") });
    expect(getRow().node).toBe("done");
  });

  it("leaves a restarted welcome alone when the closing message it waited on fails", async () => {
    const { fx, getRow } = makeEffects("building", { buildSessionId: "build-chat" });
    let failPost: (posted: boolean) => void = () => {};
    let waiting: () => void = () => {};
    const reachedPost = new Promise<void>((resolve) => (waiting = resolve));
    rs.mocked(fx.closingInFlight).mockImplementation(() => {
      waiting();
      return new Promise<boolean>((resolve) => (failPost = resolve));
    });

    const turn = runTurn(DISMISSED, fx);
    await reachedPost;
    // The guardian starts over while the post is still sending.
    fx.progress.patch({ node: "await_names", buildSessionId: null, buildPrompt: null });
    failPost(false);

    expect(await turn).toEqual({ kind: "none" });
    expect(getRow().node).toBe("await_names");
    expect(getRow().completedAt).toBeNull();
  });

  it("recognizes the build's first turn by the picked idea's prompt, in a webchat chat", () => {
    const { getRow } = makeEffects("building", {
      ideas: [
        { title: "Launch tracker", prompt: "Build me a launch tracker." },
        { title: "Habit garden", prompt: "Build me a habit garden." },
      ],
      buildPrompt: "Build me a launch tracker.",
    });
    const turn = {
      agentName: "core:main",
      threadId: "build-chat",
      prompt: "Build me a launch tracker.",
    };

    expect(isOnboardingBuildTurn(getRow(), turn)).toBe(true);
    // Core can put the open surfaces ahead of the brief.
    const withWorkspace = `<workspace_context>\nOpen: Notes\n</workspace_context>\n\n${turn.prompt}`;
    expect(isOnboardingBuildTurn(getRow(), { ...turn, prompt: withWorkspace })).toBe(true);
    // A prompt that only quotes the brief, as another handoff's could, is not the build.
    expect(
      isOnboardingBuildTurn(getRow(), {
        ...turn,
        prompt: `Help me rename this. "Build me a launch tracker."`,
      }),
    ).toBe(false);
    // Another offered idea, another agent, another prompt, another channel, or
    // a finished welcome is ordinary chat.
    expect(isOnboardingBuildTurn(getRow(), { ...turn, prompt: "Build me a habit garden." })).toBe(
      false,
    );
    expect(isOnboardingBuildTurn(getRow(), { ...turn, agentName: "notes:writer" })).toBe(false);
    expect(isOnboardingBuildTurn(getRow(), { ...turn, prompt: "Add a dark mode." })).toBe(false);
    expect(isOnboardingBuildTurn(getRow(), { ...turn, threadId: null })).toBe(false);
    expect(isOnboardingBuildTurn({ ...getRow(), node: "done" }, turn)).toBe(false);
  });

  it("reads the chat from a webchat key only", () => {
    expect(webchatThreadId("webchat:chat-1")).toBe("chat-1");
    expect(webchatThreadId("telegram:42")).toBeNull();
    expect(webchatThreadId("webchat:chat-1:subagent:abc")).toBeNull();
    expect(webchatThreadId("webchat:chat-1#fork:abc")).toBeNull();
  });

  it("counts every later turn in the build chat, and no other chat", () => {
    const { fx, getRow } = makeEffects("building");
    startBuild(fx.progress, "build-chat");
    const later = { agentName: "core:main", threadId: "build-chat", prompt: "Use a table." };

    expect(isOnboardingBuildTurn(getRow(), later)).toBe(true);
    expect(isOnboardingBuildTurn(getRow(), { ...later, threadId: "other-chat" })).toBe(false);
  });

  it("closes after a build turn that finished, once the explore message posts", () => {
    const { fx, getRow } = makeEffects("building");
    startBuild(fx.progress, "build-chat");

    const text = closingMessageAfterBuild(getRow(), "en", "build-chat", {
      status: "completed",
      suspended: false,
    });

    expect(text).toContain("all set");
    expect(text).toContain("App Store");
    // Onboarding ends only once the message posts.
    expect(getRow().node).toBe("building");
    finishBuild(fx.progress, "build-chat");
    expect(getRow().node).toBe("done");
    expect(getRow().completedAt).toEqual(expect.any(String));
  });

  it.each([
    ["stopped", { status: "interrupted", suspended: false }],
    ["failed", { status: "error", suspended: false }],
    ["parked on a card", { status: "completed", suspended: true }],
    ["ended on a host that reports no outcome", undefined],
  ] as const)("keeps waiting on the build after a turn that %s", (_label, outcome) => {
    const { fx, getRow } = makeEffects("building");
    startBuild(fx.progress, "build-chat");

    expect(closingMessageAfterBuild(getRow(), "en", "build-chat", outcome)).toBeNull();
    expect(getRow().node).toBe("building");
  });

  it("posts nothing when onboarding no longer waits on this build", () => {
    const finished = { status: "completed", suspended: false } as const;
    // The guardian closed the handoff while the build ran, which already closed the welcome.
    const closed = makeEffects("done", { buildSessionId: "build-chat" });
    expect(closingMessageAfterBuild(closed.getRow(), "en", "build-chat", finished)).toBeNull();
    // The guardian started over, and a new run is building in another chat.
    const restarted = makeEffects("building", { buildSessionId: "new-chat" });
    expect(closingMessageAfterBuild(restarted.getRow(), "en", "build-chat", finished)).toBeNull();
    // Nor does a post that lands after the guardian started over end the new run.
    finishBuild(restarted.fx.progress, "build-chat");
    expect(restarted.getRow().node).toBe("building");
  });

  it("says nothing when the build handoff ends after the welcome closed", async () => {
    const { fx } = makeEffects("done", { completedAt: "2026-01-01" });

    expect(await runTurn(DISMISSED, fx)).toEqual({ kind: "none" });
    expect(await runTurn(resolved({ summary: "done" }), fx)).toEqual({ kind: "none" });
    // A typed message still gets the reminder, even one with a JSON snippet or
    // core's dismissal phrase.
    // Behind the context blocks core can put ahead of the prompt, too.
    expect(await runTurn(`${THREAD_CONTEXT}${WORKSPACE_CONTEXT}${DISMISSED}`, fx)).toEqual({
      kind: "none",
    });
    expect(await runTurn(`${WORKSPACE_CONTEXT}${resolved({ summary: "done" })}`, fx)).toEqual({
      kind: "none",
    });
    for (const typed of [
      "hello again",
      `Why does this fail?\n${resolution({ a: 1 })}`,
      "Why do I see 'dismissed the interaction' here?",
      `${WORKSPACE_CONTEXT}Why do I see "${DISMISSED}" here?`,
    ]) {
      expect(await runTurn(typed, fx)).toMatchObject({
        kind: "text",
        text: expect.stringContaining("already finished"),
      });
    }
  });

  it("uses the Chinese fallback title without changing the English one", async () => {
    const { fx } = makeEffects("await_idea", { aiConnected: true });
    rs.mocked(fx.getLocale).mockResolvedValue("zh-CN");

    const reply = await runTurn(resolution({ ideaTitle: "培养习惯" }), fx);
    expect(reply).toMatchObject({ kind: "handoff", lead: expect.stringContaining("「培养习惯」") });

    const { fx: englishFx } = makeEffects("await_idea", { aiConnected: true });
    const englishReply = await runTurn(resolution({ ideaTitle: "Habit garden" }), englishFx);
    expect(englishReply).toMatchObject({
      kind: "handoff",
      lead: expect.stringContaining('Let\'s build "Habit garden"'),
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

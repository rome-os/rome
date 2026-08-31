// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { normalizeBondLevel, type PeopleList, type PersonResource } from "@rome/api-types/people";
import i18n from "@/i18n";
import { ChatComposer, type ChatComposerProps } from "./ChatComposer";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
  rs.unstubAllGlobals();
});

/** jsdom has no matchMedia; stub one whose coarse-pointer query answers `matches`. */
function stubCoarsePointer(matches: boolean) {
  rs.stubGlobal(
    "matchMedia",
    rs.fn((query: string) => ({
      matches: query === "(hover: none) and (pointer: coarse)" ? matches : false,
      media: query,
      addEventListener: rs.fn(),
      removeEventListener: rs.fn(),
    })),
  );
}

function person(id: string, displayName: string, bondLevel: string): PersonResource {
  return { id, displayName, bondLevel, accounts: [], messageCount: 0, latest: null };
}

/** A `GET /api/people` body, with the counts the route derives from the rows. */
function peopleList(people: PersonResource[]): PeopleList {
  const counts = { all: 0, guardian: 0, "inner-circle": 0, acquaintance: 0, other: 0 };
  for (const row of people) {
    counts[normalizeBondLevel(row.bondLevel)] += 1;
    counts.all += 1;
  }
  return { people, counts };
}

interface RenderComposerOptions {
  settings?: Record<string, unknown>;
  /** What `GET /api/people` answers. Defaults to a listing with nobody in it. */
  people?: PersonResource[];
}

function renderComposer(props: Partial<ChatComposerProps>, options: RenderComposerOptions = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const fetchSpy = rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
  ) => {
    const url = String(input);
    if (url === "/api/settings") {
      return Response.json({ guardianName: "Ada", ...options.settings });
    }
    if (url === "/api/people") return Response.json(peopleList(options.people ?? []));
    if (url === "/api/skills") {
      return Response.json({
        skills: [
          {
            name: "@ray/scoped-app:identity_probe",
            localName: "identity_probe",
            description: "Scoped identity probe",
            tools: [],
            ownerType: "app",
            ownerId: "@ray/scoped-app",
            ownerLabel: "Scoped App",
            ownerDescription: "Scoped app test fixture",
            iconUrl: null,
          },
        ],
      });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch);

  return {
    fetchSpy,
    ...render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <ChatComposer onSend={rs.fn()} {...props} />
        </QueryClientProvider>
      </MemoryRouter>,
    ),
  };
}

// The people the composer offers to speak as. The listing is the curated
// people read (`GET /api/people`); the guardian is dropped because speaking as
// the guardian is what the composer already does by default.
describe("composer mention list", () => {
  const GUARDIAN = person("mock-guardian", "Mock Guardian", "guardian");
  const RAY = person("ray-oster", "Ray Oster", "inner-circle");
  const SAM = person("sam-okafor", "Sam Okafor", "colleague");

  it("renders its people from GET /api/people", async () => {
    const { fetchSpy } = renderComposer(
      {},
      { settings: { enableImpersonation: true }, people: [GUARDIAN, RAY, SAM] },
    );

    await userEvent.click(await screen.findByRole("button", { name: "Impersonation" }));

    expect(await screen.findByText("Ray Oster")).toBeTruthy();
    expect(screen.getByText("Sam Okafor")).toBeTruthy();
    await waitFor(() =>
      expect(fetchSpy.mock.calls.map(([input]) => String(input))).toContain("/api/people"),
    );
  });

  it("excludes the guardian", async () => {
    renderComposer({}, { settings: { enableImpersonation: true }, people: [GUARDIAN, RAY] });

    await userEvent.click(await screen.findByRole("button", { name: "Impersonation" }));

    await screen.findByText("Ray Oster");
    expect(screen.queryByText("Mock Guardian")).toBeNull();
  });

  it("offers nobody when the listing holds only the guardian", async () => {
    renderComposer({}, { settings: { enableImpersonation: true }, people: [GUARDIAN] });

    await userEvent.click(await screen.findByRole("button", { name: "Impersonation" }));

    expect(await screen.findByText("No other users available.")).toBeTruthy();
  });
});

describe("composer error status", () => {
  it("renders the recovery status outside the chatbox with a primary action", () => {
    renderComposer({
      streamError: {
        message: "Selected model provider is unavailable: Codex",
        code: "model_provider_unavailable",
        provider: "openai",
        reason: "not_logged_in",
      },
    });

    const status = screen.getByRole("alert");
    const chatbox = document.querySelector("[data-chat-composer-box]");
    const action = screen.getByRole("link", { name: /go to sign in/i });

    expect(chatbox?.contains(status)).toBe(false);
    expect(status.compareDocumentPosition(chatbox as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(action.className).toContain("bg-primary");
  });
});

// Handoff affordances on the composer: a submitted result raises the Approve
// banner; before that, the floor agent chip in the pre-send row hosts Cancel on
// its × (there is no separate "Collaborating with" bar anymore).
describe("composer handoff bar", () => {
  it("offers Approve when the specialist has a pending submission", () => {
    const onApprove = rs.fn();
    renderComposer({ designingInteraction: { agentLabel: "Workflow author", onApprove } });

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("hosts Cancel on the floor agent chip (no Approve) before a submission", () => {
    const onCancel = rs.fn();
    renderComposer({
      // During a handoff the floor agent is pinned — that chip carries the ×.
      pinnedAgentMention: {
        appId: "workflow-builder",
        appLabel: "Workflow Builder",
        agentName: "workflow-builder",
        iconUrl: "/api/apps/workflow-builder/icon",
      },
      designingInteraction: { agentLabel: "Workflow Builder", onCancel },
    });

    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    // The chip shows the readable agent name, and its × cancels the handoff.
    expect(screen.getByText("Workflow Builder")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel collaboration" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

// Enter-to-send is a desktop convention: keyboards there have Shift+Enter for
// newlines. On touch-first devices (no hover, coarse pointer) the popular
// design is the opposite — Enter inserts a newline and the send button sends —
// so a stray tap on the soft keyboard's return key can't fire a half-written
// message.
describe("composer Enter key", () => {
  it("sends on Enter on desktop (fine pointer)", () => {
    stubCoarsePointer(false);
    const onSend = rs.fn().mockResolvedValue(undefined);
    renderComposer({ onSend });

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0].text).toBe("hello");
  });

  it("does not send on Enter on touch-first devices (Enter is a newline there)", () => {
    stubCoarsePointer(true);
    const onSend = rs.fn().mockResolvedValue(undefined);
    renderComposer({ onSend });

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // Enter falls through to the textarea's default newline behavior; only
    // the send button submits.
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0].text).toBe("hello");
  });
});

describe("composer scoped slash skill", () => {
  it("keeps the picker open through a scoped canonical id and submits its full name", async () => {
    const onSend = rs.fn().mockResolvedValue(undefined);
    renderComposer({ onSend });

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    const command = "/@ray/scoped-app:identity_probe";
    fireEvent.input(textarea, { target: { value: command } });

    expect(await screen.findByText("Scoped App")).toBeTruthy();
    fireEvent.mouseDown(screen.getByText("/identity_probe"));

    expect(screen.getByRole("button", { name: "Remove skill" })).toBeTruthy();
    expect(textarea.value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toMatchObject({
      text: "",
      skillName: "@ray/scoped-app:identity_probe",
    });
  });

  it("does not open the skill picker for path-like text", async () => {
    renderComposer({});

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "/etc/hosts" } });

    await waitFor(() => expect(screen.queryByText("Pick a skill to run")).toBeNull());
  });
});

describe("composer textarea height", () => {
  // Regression: the input had an `onInput` resize handler that grew with
  // content but never shrank after a send. `setInputText("")` in `runSend`
  // clears the DOM value via React, which doesn't fire `input` — the height
  // stayed at whatever it had grown to. The fix syncs the height from a
  // useEffect on `inputText`, so the post-send reset shrinks the box.
  it("shrinks back to one line box after sending a multi-line message", () => {
    const onSend = rs.fn().mockResolvedValue(undefined);
    renderComposer({ onSend });

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    // jsdom doesn't lay out text, so we drive scrollHeight ourselves. The
    // getter tracks the textarea's current value: tall while the user has
    // content, collapsing to one line box after the optimistic clear.
    const lineBox = 20;
    const filledHeight = 200;
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => (textarea.value.length > 0 ? filledHeight : lineBox),
    });

    // Simulate the user having typed enough lines to max out the box.
    fireEvent.input(textarea, { target: { value: "line 1\nline 2\nline 3\nline 4\nline 5" } });
    expect(textarea.style.height).toBe("200px");

    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    // After the optimistic clear the value is empty. An empty textarea
    // collapses back to the min scroll height — one line box — and the
    // useEffect resyncs the box to it.
    expect(textarea.value).toBe("");
    expect(textarea.style.height).toBe(`${lineBox}px`);
    expect(textarea.style.overflowY).toBe("hidden");
  });

  // The empty composer is one line box tall, and that box belongs to the
  // `text-body` role. A px floor here would hold the old number through a
  // retune of the role and pull the text off the composer's padding, so the
  // floor is declared in line-box units and the resize below never writes one.
  it("declares its floor in line-box units rather than pixels", () => {
    renderComposer({});

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.style.minHeight).toBe("1lh");
  });

  // `min-height` outranks an explicit `height`, so the resize handler caps and
  // lets CSS floor. Writing a floor here too would reintroduce the px the test
  // above rules out — and jsdom, which applies no `min-height`, would not
  // notice the two disagreeing.
  it("caps the height without writing a floor of its own", () => {
    renderComposer({});

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    // Shorter than any real line box: a handler that floors would round this up.
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, get: () => 1 });

    fireEvent.input(textarea, { target: { value: "hi" } });

    expect(textarea.style.height).toBe("1px");
  });
});

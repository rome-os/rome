// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Assistant } from "@rome/api-types/assistants";
import "@/i18n";
import { AssistantChats } from "./AssistantChats";

const DOT = "11111111-1111-4111-8111-111111111111";
const MUSE = "22222222-2222-4222-8222-222222222222";

const assistant = (agentId: string, name: string, kind: string): Assistant => ({
  agentId,
  name,
  kind,
  account: "eric",
  sameAccount: true,
  lastMessageAt: null,
});

function serve(assistants: Assistant[] | "fail") {
  return rs.spyOn(globalThis, "fetch").mockImplementation((async () =>
    assistants === "fail"
      ? new Response("{}", { status: 503 })
      : new Response(JSON.stringify({ assistants }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch);
}

function renderGroup(path = "/chat", collapsed = false) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AssistantChats collapsed={collapsed} onToggle={() => {}} />
    </MemoryRouter>,
  );
}

describe("AssistantChats", () => {
  afterEach(() => {
    cleanup();
    rs.restoreAllMocks();
  });

  it("lists each assistant with its kind's mark, linking to its chat", async () => {
    serve([assistant(MUSE, "Muse", "muse"), assistant(DOT, "Research dot", "dot")]);
    renderGroup(`/assistants/${DOT}`);

    const section = await screen.findByRole("region", { name: "Assistants" });
    const rows = within(section).getAllByRole("link");
    expect(rows.map((row) => row.textContent)).toEqual(["Muse", "Research dot"]);
    expect(within(rows[1]!).getByRole("img", { name: "Dot" })).toBeTruthy();
    expect(within(rows[0]!).getByRole("img", { name: "Muse" })).toBeTruthy();
    expect(rows[1]!.getAttribute("href")).toBe(`/assistants/${DOT}`);
    expect(rows[1]!.getAttribute("aria-current")).toBe("page");
    expect(rows[0]!.getAttribute("aria-current")).toBeNull();
  });

  it("names a kind it has no mark for, as Rome Cloud spells it", async () => {
    serve([assistant(DOT, "Grok", "grok")]);
    renderGroup();
    expect(await screen.findByRole("img", { name: "grok" })).toBeTruthy();
  });

  it("renders nothing without assistants, or when the list cannot be read", async () => {
    const spy = serve([]);
    const { container } = renderGroup();
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");

    cleanup();
    const failing = serve("fail");
    const second = renderGroup();
    await waitFor(() => expect(failing).toHaveBeenCalled());
    expect(second.container.innerHTML).toBe("");
  });

  it("hides the rows while collapsed", async () => {
    serve([assistant(DOT, "Research dot", "dot")]);
    renderGroup("/chat", true);
    const heading = await screen.findByRole("button", { name: "Assistants" });
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link")).toBeNull();
  });
});
